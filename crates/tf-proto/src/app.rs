//! App-level types: host profiles, connection status, settings, tunnels, and the event
//! stream the app core pushes to the frontend.

use crate::model::{HostState, Notification, Pulse, StatePatch, ThinkingLevel};
use crate::notify::DeviceKind;
use crate::session::SessionEvent;
use crate::term::TermEvent;
use crate::{ApiError, Millis};

wire_enum! {
    /// * `tailscaleSsh`: remote host over SSH. Tailscale SSH by default (no credentials; tailnet
    ///   identity); password or private-key sign-in as the advanced setup ([`HostProfile::auth`]).
    /// * `local`: herdr on this desktop machine (Windows).
    /// * `wsl`: herdr inside a WSL distro on this desktop machine.
    /// * `demo`: built-in simulated host (handled entirely by the frontend).
    pub enum HostKind { TailscaleSsh, Local, Wsl, Demo }
}

wire_enum! {
    /// How a `tailscaleSsh` host signs in. Only the configured method is used (plus SSH `none`,
    /// which needs no credentials); there is no fallback to other credentials.
    /// * `tailscale`: SSH `none` auth, Tailscale SSH vouches for this device (default, recommended).
    /// * `key`: a private key: [`HostProfile::key_path`] on this device, else the key saved with
    ///   `hosts.save` (imported on Android). Its passphrase, if any, is saved too.
    /// * `password`: the password saved with `hosts.save`.
    pub enum SshAuth { Tailscale, Key, Password }
}

wire_struct! {
    pub struct HostProfile {
        pub id: String,
        pub name: String,
        pub kind: HostKind,
        /// Host name or IP (`tailscaleSsh`): the MagicDNS name or tailnet IP for Tailscale SSH.
        pub address: Option<String>,
        /// SSH user (`tailscaleSsh`); Tailscale SSH defaults to this device's user name (the
        /// tailnet policy maps it). Required for password and key sign-in.
        pub user: Option<String>,
        pub port: Option<u16>,
        /// SSH sign-in (`tailscaleSsh`); absent = `tailscale`. Password and key secrets never live
        /// in the profile: see [`HostSecrets`].
        pub auth: Option<SshAuth>,
        /// Private key file on this device for `auth: key` (`~/` = home dir). Absent: the key saved
        /// with `hosts.save` ([`HostSecrets::private_key`]).
        pub key_path: Option<String>,
        /// WSL distro name (`wsl`).
        pub distro: Option<String>,
        /// herdr session name (`default`).
        pub herdr_session: String,
        /// Accent hue for this host in multi-host views (CSS color).
        pub color: Option<String>,
        pub auto_connect: bool,
        /// Override for the relay port on the host.
        pub relay_port: Option<u16>,
        /// Host group label (trimmed, non-empty). Hosts sharing a group form a pool that
        /// Dispatch's Auto mode spreads tasks over by their current workload.
        pub group: Option<String>,
    }
}

/// Sign-in secrets of a host using password or key sign-in. Write-only: `hosts.save` and
/// `hosts.test` accept them (`HostSaveParams::secrets`); no result, event, log line or cache file
/// carries them. The app core keeps them owner-only in its data dir (`secrets.json`), keyed by host
/// id, and deletes them with the host. `hosts.secretStatus` tells which ones are saved.
///
/// On save, per field: absent = keep the saved value, empty = delete it, text = replace it.
/// Secrets the host's sign-in method does not use are not kept.
#[serde_with::skip_serializing_none]
#[derive(Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct HostSecrets {
    pub password: Option<String>,
    /// OpenSSH or PEM private key text (imported or pasted).
    pub private_key: Option<String>,
    /// Passphrase of the private key (key file or saved key).
    pub passphrase: Option<String>,
}

/// Redacted: shows which secrets are present, never their values.
impl std::fmt::Debug for HostSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let shown = |s: &Option<String>| if s.is_some() { "<redacted>" } else { "-" };
        f.debug_struct("HostSecrets")
            .field("password", &shown(&self.password))
            .field("private_key", &shown(&self.private_key))
            .field("passphrase", &shown(&self.passphrase))
            .finish()
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
        /// Check GitHub releases while the app runs (launch, hourly, back in front) and install a
        /// newer version (Tauri app only).
        /// Settings files written before this field existed load with `true`.
        #[serde(default = "default_true")]
        pub auto_update: bool,
        /// Mark done closes the agent's herdr pane (and its worktree workspace when nothing else
        /// runs there) once it is idle; the agent stays in Done and resumes with
        /// `omp --resume` when it is needed again. Files without the field load with `true`.
        #[serde(default = "default_true")]
        pub close_done: bool,
        /// Tell hosts whether this device is in use, so they alert the device you are using first
        /// and escalate to your phone when nobody saw it (hosts ≥ 0.7.0). Absent: on.
        pub share_presence: Option<bool>,
        /// Minutes without input before this device counts as idle (1–60). Absent: 3.
        pub idle_after_min: Option<u16>,
        /// What this device is for routing (escalations go to phones). Absent: from the platform.
        pub device_kind: Option<DeviceKind>,
        /// Desktop: the system-wide shortcut that opens Quick capture, as an accelerator
        /// (`Ctrl+Alt+Space`, `Cmd+Shift+Space`). Absent or empty: off until the user sets one.
        pub capture_shortcut: Option<String>,
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
        /// Desktop: an update found by an automatic check is downloaded and verified, and waits
        /// for the user ("Restart now", or "Install" when `needs_password`) or for the window to
        /// leave the front (then it installs and restarts by itself).
        Ready,
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
        /// Installing this copy's update asks for the administrator password (`.deb`: `pkexec`),
        /// so it never starts unattended: the UI offers "Install" in `ready`.
        pub needs_password: bool,
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
    Notify {
        host_id: String,
        notification: Notification,
        /// `false`: the host routed it to another device in use; list it without a toast, sound
        /// or haptic. `true` again (same id) when it escalates to this device. Absent: alert.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        alert: Option<bool>,
    },
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
