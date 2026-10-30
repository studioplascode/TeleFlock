//! Self-update from GitHub releases (`release::REPO`).
//!
//! Discovery is shared: the releases API is read anonymously and the highest semver tag
//! (pre-releases included, drafts skipped) carrying this platform's assets wins if it is newer
//! than the running version. Install differs per platform:
//! * Windows and Linux (AppImage, `.deb`): tauri-plugin-updater reads the release's
//!   `latest.json`, downloads this platform's package, verifies its minisign signature
//!   (`plugins.updater.pubkey`) and installs it. Windows runs the NSIS installer passively and
//!   exits (the installer relaunches TeleFlock); the AppImage is replaced in place or the `.deb`
//!   installed with `pkexec dpkg -i`, then the app restarts.
//! * macOS (`manual`): the release's `.dmg` is only offered; `app.updateInstall` opens it in the
//!   browser. It is built in CI, which never gets the updater key, so nothing installs by itself.
//! * Android: the universal APK is downloaded to the app cache, checked against the release's
//!   `.sha256`, then checked by the Kotlin plugin (same package name, same signing certificates,
//!   higher versionCode than the installed app) and handed to the system installer (FileProvider URI).
//!
//! Copies that must not replace themselves (debug builds, the Arch package, a bare binary) report
//! `supported: false` with the reason (`release::Target::current`).
//!
//! Automatic checks run here, not in the webview (which is gone on Android while the keep-alive
//! service keeps the process up without an activity): shortly after launch, about hourly, and
//! when the app comes back to the front (window focus, `MainActivity.onResume`) if the last
//! check is 20 minutes old (`schedule`). They only run while `settings.autoUpdate` is on.
//! Android starts the installer only while the app is in front; otherwise the verified APK
//! waits for the next resume.
//!
//! What an automatic check finds must not surprise the user (`apply`): on Windows and Linux it
//! is downloaded in the background and verified, then waits as `UpdatePhase::Ready` ("Restart
//! now") while the user is in front: the main window shown, not minimized and focused, or Quick
//! capture in use (focused, text typed in it, or holding pasted images or a send in flight; they
//! live in memory only). It installs and restarts by itself once the user has been away for an
//! uninterrupted `apply::AWAY_GRACE`: any return (either window focused, capture opened or typed
//! in) voids the pending timers, so alt-tabbing away, back and away again counts only the last
//! absence. The AppImage also installs when the app quits (the quit is the user's own and nothing
//! restarts). The `.deb` (`pkexec` password prompt) never installs unattended: it
//! stays `ready` until the user clicks **Install**. A manual check or click installs at once.
//!
//! The webview drives it through `core_call` app methods answered here instead of the engine
//! (`app.updateStatus`, `app.updateCheck`, `app.updateInstall`); progress is pushed as
//! `AppEvent::Update` on the regular event channel. Failures never surface on their own: they
//! are logged and kept in the status for Settings, and automatic checks back off.

mod apply;
mod net;
pub mod release;
mod schedule;

use std::sync::{Arc, Mutex};

use semver::Version;
use serde_json::Value;
use tauri::{AppHandle, Wry};
use tf_proto::{ApiError, AppEvent, AppMethod, Settings, UpdateCheckParams, UpdatePhase, UpdateStatus};
use tokio::sync::Notify;

#[cfg(desktop)]
use self::apply::Apply;
use self::apply::Origin;
use self::release::{Candidate, Target};
use self::schedule::{Outcome, Schedule, Trigger};
use crate::core::CoreState;

/// App methods answered by the shell (see the module docs).
pub const METHODS: &[&str] = &["app.updateStatus", "app.updateCheck", "app.updateInstall"];

pub type UpdaterState = Arc<Updater>;

pub struct Updater {
    #[cfg_attr(not(any(desktop, target_os = "android")), allow(dead_code))]
    app: AppHandle<Wry>,
    core: CoreState,
    current: Version,
    /// `None`: this copy can't update itself (`status.unsupported_reason` says why).
    target: Option<Target>,
    user_agent: String,
    state: Mutex<State>,
    /// Wakes the automatic checks: the app came back to the front.
    foreground: Notify,
    /// Desktop: the departures an automatic install waits out (`apply::Away`).
    #[cfg(desktop)]
    away: apply::Away,
    /// Desktop: the downloaded, verified package of an update that waits as `UpdatePhase::Ready`.
    #[cfg(desktop)]
    pending: Mutex<Option<Pending>>,
}

/// A downloaded update the plugin can still install (`apply`).
#[cfg(desktop)]
struct Pending {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
    version: Version,
}

struct State {
    status: UpdateStatus,
    candidate: Option<Candidate>,
    schedule: Schedule,
    /// Android: the verified APK waiting for the install permission / the system prompt.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    apk: Option<std::path::PathBuf>,
    /// Android: the APK was ready while the app was in the background; the installer starts on
    /// the next resume.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    prompt_pending: bool,
}

fn busy(p: UpdatePhase) -> bool {
    matches!(p, UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Installing)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// `settings.autoUpdate`; settings that can't be read count as off (never install unasked).
async fn auto_update_enabled(engine: &tf_client::Engine) -> bool {
    // `settings.get` takes `Empty`: its params must be `{}` (`null` is rejected as invalid_params).
    let settings = engine
        .call(None, "settings.get", Value::Object(Default::default()))
        .await
        .and_then(|v| serde_json::from_value::<Settings>(v).map_err(|e| ApiError::new("internal", e.to_string())));
    match settings {
        Ok(s) => s.auto_update,
        Err(e) => {
            log::warn!("update: can't read settings ({e}); skipping the automatic update");
            false
        }
    }
}

impl Updater {
    pub fn new(app: AppHandle<Wry>, core: CoreState) -> UpdaterState {
        let version = app.package_info().version.clone();
        // Debug builds (tauri dev, `.debug` Android package) must never replace the installed app.
        let target = if cfg!(debug_assertions) {
            Err("This build doesn't update itself (development build). Install a release from GitHub to get updates.")
        } else {
            Target::current()
        };
        if let Err(reason) = target {
            log::info!("update: self-update off: {reason}");
        }
        let status = UpdateStatus {
            current: version.to_string(),
            supported: target.is_ok(),
            manual: target == Ok(Target::MacOs),
            needs_password: target.is_ok_and(apply::needs_password),
            unsupported_reason: target.err().map(str::to_owned),
            phase: UpdatePhase::Idle,
            latest: None,
            progress: None,
            error: None,
            checked_at: None,
        };
        Arc::new(Self {
            user_agent: format!("TeleFlock/{version} ({})", crate::PLATFORM_NAME),
            current: version,
            target: target.ok(),
            app,
            core,
            state: Mutex::new(State {
                status,
                candidate: None,
                schedule: Schedule::default(),
                apk: None,
                prompt_pending: false,
            }),
            foreground: Notify::new(),
            #[cfg(desktop)]
            away: apply::Away::default(),
            #[cfg(desktop)]
            pending: Mutex::new(None),
        })
    }

    /// Starts the automatic checks (module docs); nothing for copies that can't update.
    pub fn start(self: &Arc<Self>) {
        if self.target.is_none() {
            return;
        }
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            schedule::run(schedule::TIMING, &me.foreground, |t| me.auto_check(t)).await;
        });
    }

    /// The app is in front again (window focused, activity resumed): may trigger a check, and
    /// voids a pending automatic install (the user's absence must be uninterrupted).
    pub fn foreground(&self) {
        #[cfg(desktop)]
        self.away.returned();
        self.foreground.notify_one();
    }

    /// One automatic check if it is due and `settings.autoUpdate` is on.
    async fn auto_check(self: &Arc<Self>, trigger: Trigger) {
        let due = {
            let s = self.lock();
            s.schedule.due(trigger, now_ms(), s.status.phase)
        };
        if !due || !auto_update_enabled(&self.core.engine).await {
            return;
        }
        log::info!("update: automatic check ({trigger:?})");
        self.check(UpdateCheckParams { install: true }, Origin::Automatic).await;
    }

    /// Desktop: the main window or Quick capture left the front (hidden, minimized, lost the
    /// focus, put away, emptied). A downloaded update that waits installs once the user stays
    /// away for [`apply::AWAY_GRACE`] without a break.
    #[cfg(desktop)]
    pub fn left_front(self: &Arc<Self>) {
        if self.lock().status.phase == UpdatePhase::Ready {
            self.settle();
        }
    }

    /// Desktop: the user is working in a window of the app (Quick capture shown or typed in):
    /// whatever departure was being timed is void.
    #[cfg(desktop)]
    pub fn active(&self) {
        self.away.returned();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> UpdateStatus {
        self.lock().status.clone()
    }

    /// Mutates the status and pushes it to the webview.
    fn update(&self, f: impl FnOnce(&mut State)) -> UpdateStatus {
        let status = {
            let mut s = self.lock();
            f(&mut s);
            s.status.clone()
        };
        self.core.engine.emit(AppEvent::Update { status: status.clone() });
        status
    }

    fn fail(&self, e: String) -> UpdateStatus {
        log::warn!("update: {e}");
        self.update(|s| {
            s.status.phase = UpdatePhase::Error;
            s.status.progress = None;
            s.status.error = Some(e);
            s.schedule.failed();
        })
    }

    /// `core_call` entry for [`METHODS`].
    pub async fn call(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, ApiError> {
        let status = match AppMethod::parse(method, params)? {
            AppMethod::AppUpdateStatus(_) => self.status(),
            AppMethod::AppUpdateCheck(p) => self.check(p, Origin::Manual).await,
            AppMethod::AppUpdateInstall(_) => self.install(Origin::Manual)?,
            m => return Err(ApiError::new("unknown_method", format!("{} is not an update method", m.name()))),
        };
        serde_json::to_value(status).map_err(|e| ApiError::new("internal", e.to_string()))
    }

    /// Looks for a newer release; resolves once discovery is done (the install, if any, runs on).
    pub async fn check(self: &Arc<Self>, p: UpdateCheckParams, origin: Origin) -> UpdateStatus {
        let Some(target) = self.target else { return self.status() };
        {
            let mut s = self.lock();
            // A downloaded update waits for the user: a new check would replace it.
            if busy(s.status.phase) || s.status.phase == UpdatePhase::Ready {
                return s.status.clone();
            }
            s.status.phase = UpdatePhase::Checking;
            s.status.error = None;
        }
        self.update(|_| {});

        let found = match net::client(&self.user_agent) {
            Ok(client) => net::releases(&client).await,
            Err(e) => Err(e),
        }
        .map(|rels| release::newer(&rels, target, &self.current));
        let found = match found {
            Ok(found) => found,
            Err(e) => {
                log::warn!("update: check failed: {e}");
                return self.update(|s| {
                    s.status.phase = UpdatePhase::Error;
                    s.status.error = Some(format!("update check failed: {e}"));
                    s.status.checked_at = Some(now_ms());
                    s.schedule.checked(now_ms(), Outcome::Failed, schedule::jitter());
                });
            }
        };
        let available = found.is_some();
        match &found {
            Some(c) => log::info!("update: {} available (running {})", c.tag, self.current),
            None => log::info!("update: {} is up to date", self.current),
        }
        // Manual platforms only report the new version; the user downloads it (install()).
        let install = available && p.install && self.target != Some(Target::MacOs);
        let status = self.update(|s| {
            s.status.phase = if available { UpdatePhase::Available } else { UpdatePhase::UpToDate };
            s.status.latest = found.as_ref().map(|c| c.version.to_string());
            s.status.checked_at = Some(now_ms());
            s.candidate = found;
            let outcome = if install { Outcome::Installing } else { Outcome::Done };
            s.schedule.checked(now_ms(), outcome, schedule::jitter());
        });
        if install { self.install(origin).unwrap_or(status) } else { status }
    }

    /// Starts downloading + installing the release found by the last check. Manual platforms
    /// (macOS): opens the release's package in the browser instead and stays `available`. A
    /// downloaded update that waits (`ready`) installs now. An `Automatic` origin only
    /// downloads: the install follows when `apply::decide` allows it.
    pub fn install(self: &Arc<Self>, origin: Origin) -> Result<UpdateStatus, ApiError> {
        #[cfg(desktop)]
        if self.lock().status.phase == UpdatePhase::Ready
            && let Some(status) = self.apply_pending()
        {
            return Ok(status);
        }
        let candidate = {
            let mut s = self.lock();
            if busy(s.status.phase) {
                return Ok(s.status.clone());
            }
            let Some(c) = s.candidate.clone() else {
                return Err(ApiError::new("not_found", "no update available: check for updates first"));
            };
            if let release::Assets::Download { url } = &c.assets {
                let status = s.status.clone();
                drop(s);
                use tauri::Manager;
                log::info!("update: opening the {} download", c.tag);
                let platform = self.app.state::<Arc<crate::platform::TauriPlatform>>();
                tf_client::Platform::open_external(&**platform, url)?;
                return Ok(status);
            }
            s.status.phase = UpdatePhase::Downloading;
            s.status.progress = None;
            s.status.error = None;
            c
        };
        let status = self.update(|_| {});
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            log::info!("update: installing {}", candidate.tag);
            if let Err(e) = me.run_install(&candidate, origin).await {
                me.fail(format!("updating to {} failed: {e}", candidate.version));
            }
        });
        Ok(status)
    }

    /// Download progress → status, emitted once per whole percent.
    #[cfg_attr(not(any(desktop, target_os = "android")), allow(dead_code))]
    fn progress(&self) -> impl FnMut(u64, Option<u64>) + '_ {
        let mut last = None;
        move |done, total| {
            let pct = total.filter(|t| *t > 0).map(|t| (done.saturating_mul(100) / t).min(100) as u8);
            if pct != last {
                last = pct;
                self.update(|s| s.status.progress = pct);
            }
        }
    }

    #[cfg_attr(not(desktop), allow(unused_variables))]
    async fn run_install(self: &Arc<Self>, c: &Candidate, origin: Origin) -> Result<(), String> {
        match &c.assets {
            #[cfg(desktop)]
            release::Assets::Manifest { manifest_url } => self.install_plugin(manifest_url, &c.version, origin).await,
            #[cfg(target_os = "android")]
            release::Assets::Android { apk_name, apk_url, sha256_url } => {
                self.install_android(apk_name, apk_url, sha256_url).await
            }
            #[allow(unreachable_patterns)]
            _ => Err("this platform can't install updates".into()),
        }
    }

    /// Windows / Linux through tauri-plugin-updater (see the module docs). `version` is
    /// the release tag's: `latest.json` must announce exactly that version, and
    /// `plugins.updater.requireSignedVersion` makes the plugin reject a package whose signature
    /// was made for another version, so an older signed package can't be replayed under a newer tag.
    #[cfg(desktop)]
    async fn install_plugin(self: &Arc<Self>, manifest_url: &str, version: &Version, origin: Origin) -> Result<(), String> {
        use tauri_plugin_updater::UpdaterExt;
        let url: tauri::Url = manifest_url.parse().map_err(|e| format!("bad manifest URL: {e}"))?;
        let app = self.app.clone();
        let updater = self
            .app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            // No overall timeout (the package is large on slow links), but a stalled connection
            // fails the download instead of leaving the phase at `downloading` forever.
            .configure_client(|b| {
                b.connect_timeout(std::time::Duration::from_secs(15))
                    .read_timeout(std::time::Duration::from_secs(60))
            })
            // Windows: runs right before the installer starts and the process exits:
            // RunEvent::Exit won't. Other platforms restart below instead.
            .on_before_exit(move || {
                crate::before_exit(&app);
                app.cleanup_before_exit();
            })
            .build()
            .map_err(|e| e.to_string())?;
        let update = updater
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the release's latest.json offers no newer version")?;
        if Version::parse(update.version.trim_start_matches('v')).ok().as_ref() != Some(version) {
            return Err(format!("the release's latest.json announces {}, not {version}", update.version));
        }
        let mut progress = self.progress();
        let mut done = 0u64;
        // `download` verifies the minisign signature against plugins.updater.pubkey.
        let bytes = update
            .download(
                |chunk, total| {
                    done += chunk as u64;
                    progress(done, total);
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        let pending = Pending { update, bytes, version: version.clone() };
        if origin == Origin::Manual {
            self.update(|s| {
                s.status.phase = UpdatePhase::Installing;
                s.status.progress = None;
            });
            return self.install_pending(pending).await;
        }
        // Not asked for by the user: keep the verified package and let `apply::decide` pick the
        // moment (the window leaving the front, a click, the quit).
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(pending);
        log::info!("update: {version} downloaded; waiting for the window to leave the front or for the user");
        self.update(|s| {
            s.status.phase = UpdatePhase::Ready;
            s.status.progress = None;
        });
        self.settle();
        Ok(())
    }

    /// Runs the plugin's install and restarts. Windows: starts the passive installer (it
    /// relaunches TeleFlock) and exits the process. Linux: replaces the AppImage or runs
    /// `pkexec dpkg -i` (which waits for the password prompt). Off the async workers: both block.
    #[cfg(desktop)]
    async fn install_pending(self: &Arc<Self>, p: Pending) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || p.update.install(p.bytes))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        // Not reached on Windows. Elsewhere the new version is on disk: restart into it through
        // the regular exit path (RunEvent::Exit → engine shutdown).
        log::info!("update: installed, restarting");
        self.app.request_restart();
        Ok(())
    }

    /// Takes the waiting package and installs it in the background (`ready` → `installing`).
    /// `None` when there is none (already taken).
    #[cfg(desktop)]
    fn apply_pending(self: &Arc<Self>) -> Option<UpdateStatus> {
        let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner()).take()?;
        let status = self.update(|s| {
            s.status.phase = UpdatePhase::Installing;
            s.status.progress = None;
            s.status.error = None;
        });
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let version = pending.version.clone();
            if let Err(e) = me.install_pending(pending).await {
                me.fail(format!("updating to {version} failed: {e}"));
            }
        });
        Some(status)
    }

    /// The user is in front of the app: the main window is shown, not minimized and focused (an
    /// unreadable window counts as in front), or Quick capture is in use (`apply::capture_in_front`).
    #[cfg(desktop)]
    fn in_front(&self) -> bool {
        use tauri::Manager;
        let main = self.app.get_webview_window("main").is_some_and(|w| {
            apply::in_front(
                w.is_visible().unwrap_or(true),
                w.is_minimized().unwrap_or(false),
                w.is_focused().unwrap_or(true),
            )
        });
        let c = crate::capture::usage(&self.app);
        main || apply::capture_in_front(c.visible, c.focused, c.typing, c.unsaved)
    }

    /// After [`apply::AWAY_GRACE`] of uninterrupted absence (no return to the front, no later
    /// departure: [`apply::Away`]), installs the waiting update if the user is not in front then
    /// (and `settings.autoUpdate` is still on). The departure is recorded now, not when the task
    /// first runs.
    #[cfg(desktop)]
    fn settle(self: &Arc<Self>) {
        let me = Arc::clone(self);
        let departure = self.away.left();
        tauri::async_runtime::spawn(async move {
            if !me.away.stayed_away(departure, apply::AWAY_GRACE).await {
                return;
            }
            let Some(target) = me.target else { return };
            if me.lock().status.phase != UpdatePhase::Ready
                || apply::decide(Origin::Automatic, target, me.in_front()) != Apply::Now
                || !auto_update_enabled(&me.core.engine).await
            {
                return;
            }
            // The settings read yielded: the user may have come back meanwhile.
            if !me.away.unchanged(departure) {
                return;
            }
            log::info!("update: the user is out of the way, installing");
            me.apply_pending();
        });
    }

    /// `RunEvent::Exit`: installs a waiting update that doesn't restart anything (the AppImage,
    /// `apply::applies_on_quit`) so the next start runs the new version.
    #[cfg(desktop)]
    pub fn apply_on_quit(&self) {
        if !self.target.is_some_and(apply::applies_on_quit) {
            return;
        }
        let Some(pending) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        if !tauri::async_runtime::block_on(auto_update_enabled(&self.core.engine)) {
            return;
        }
        log::info!("update: installing {} before quitting", pending.version);
        if let Err(e) = pending.update.install(pending.bytes) {
            log::warn!("update: installing {} at quit failed: {e}", pending.version);
        }
    }

    #[cfg(target_os = "android")]
    async fn install_android(self: &Arc<Self>, apk_name: &str, apk_url: &str, sha256_url: &str) -> Result<(), String> {
        use tauri::Manager;
        let client = net::client(&self.user_agent)?;
        let sha256 = net::sha256_of(&client, sha256_url).await?;
        // Cache dir = Context.getCacheDir(), exposed by the app's FileProvider (`res/xml/file_paths.xml`).
        let dest = self.app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates").join(apk_name);
        net::download_verified(&client, apk_url, &dest, &sha256, self.progress()).await?;
        let in_front = tauri_plugin_teleflock_android::in_foreground();
        self.lock().apk = Some(dest);
        if in_front {
            return self.launch_apk(true);
        }
        // The installer can't start from the background (no activity, or not in front): keep the
        // verified APK and prompt on the next resume.
        log::info!("update: downloaded in the background; installing when TeleFlock is opened");
        self.update(|s| {
            s.prompt_pending = true;
            s.status.progress = None;
            s.status.phase = UpdatePhase::Available;
        });
        Ok(())
    }

    /// Hands the verified APK to the system installer. The plugin first checks the archive
    /// itself (same package, same signing certificates, higher versionCode) and deletes it when
    /// it doesn't match. Without the "install unknown apps" permission, opens its settings screen
    /// (`open_settings`) and waits for [`Self::resumed`].
    #[cfg(target_os = "android")]
    fn launch_apk(&self, open_settings: bool) -> Result<(), String> {
        use tauri_plugin_teleflock_android::{ApkInstall, TeleFlockAndroidExt};
        let path = {
            let mut s = self.lock();
            s.prompt_pending = false;
            s.apk.clone().ok_or("no downloaded update")?
        };
        let r = self.app.teleflock_android().install_apk(&path.to_string_lossy(), open_settings).map_err(|e| {
            // A rejected APK is gone (deleted by the plugin); don't offer it again.
            self.lock().apk = None;
            format!("couldn't install the update: {e}")
        })?;
        self.update(|s| {
            s.status.progress = None;
            s.status.phase = match r {
                ApkInstall::Started => UpdatePhase::Installing,
                ApkInstall::NeedsPermission => UpdatePhase::NeedsPermission,
            };
        });
        Ok(())
    }

    /// Android: the activity is in front again (back from the permission screen or the system
    /// installer, or opened again). A granted permission continues the install, an APK
    /// downloaded in the background gets its installer prompt now; a dismissed installer leaves
    /// the update available (a completed install replaces this process instead) and backs the
    /// automatic checks off. Otherwise an automatic check may be due.
    #[cfg(target_os = "android")]
    pub fn resumed(self: &Arc<Self>) {
        let (phase, prompt_pending) = {
            let s = self.lock();
            (s.status.phase, s.prompt_pending)
        };
        let open_settings = match phase {
            UpdatePhase::NeedsPermission => false,
            // Error: a later check failed; the verified APK still waits.
            UpdatePhase::Available | UpdatePhase::Error if prompt_pending => true,
            UpdatePhase::Installing => {
                self.update(|s| {
                    s.status.phase = UpdatePhase::Available;
                    s.schedule.failed();
                });
                return;
            }
            _ => return self.foreground(),
        };
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if let Err(e) = me.launch_apk(open_settings) {
                me.fail(e);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use tf_client::{BadgeState, Engine, EngineConfig, NotifyStyle, Platform};
    use tf_proto::{HostProfile, Notification};

    use super::*;

    struct NullPlatform;
    impl Platform for NullPlatform {
        fn notify(&self, _: Option<&HostProfile>, _: &Notification, _: NotifyStyle) {}
        fn open_external(&self, _: &str) -> Result<(), ApiError> {
            Ok(())
        }
        fn set_keep_alive(&self, _: bool) {}
        fn set_badge(&self, _: BadgeState) {}
        fn device_name(&self) -> String {
            "test-box".into()
        }
    }

    /// Every automatic check asks this gate first, against the real engine: on for a fresh
    /// install (the default), then whatever the user saved. It used to send `null` params, which
    /// `settings.get` rejects (`invalid_params`), so it always answered "off" and no automatic
    /// check ever ran.
    #[test]
    fn automatic_checks_read_the_auto_update_setting() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = EngineConfig {
            data_dir: dir.path().to_path_buf(),
            platform_name: "linux".into(),
            client_app: "teleflock-test".into(),
            version: "0.1.0".into(),
            hostd_bins_override: None,
        };
        tauri::async_runtime::block_on(async {
            let (engine, _rx) = Engine::start(cfg, Arc::new(NullPlatform)).await;
            assert!(auto_update_enabled(&engine).await, "on by default");
            let saved = engine.call(None, "settings.get", serde_json::json!({})).await.unwrap();
            let mut settings: Settings = serde_json::from_value(saved).unwrap();
            for on in [false, true] {
                settings.auto_update = on;
                engine.call(None, "settings.set", serde_json::to_value(&settings).unwrap()).await.unwrap();
                assert_eq!(auto_update_enabled(&engine).await, on);
            }
        });
    }
}
