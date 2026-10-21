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
//! The webview drives it through `core_call` app methods answered here instead of the engine
//! (`app.updateStatus`, `app.updateCheck`, `app.updateInstall`); progress is pushed as
//! `AppEvent::Update` on the regular event channel. Failures never surface on their own: they
//! are logged and kept in the status for Settings.

mod net;
pub mod release;

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use semver::Version;
use serde_json::Value;
use tauri::{AppHandle, Wry};
use tf_proto::{ApiError, AppEvent, AppMethod, Settings, UpdateCheckParams, UpdatePhase, UpdateStatus};

use self::release::{Candidate, Target};
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
    launch_checked: AtomicBool,
}

struct State {
    status: UpdateStatus,
    candidate: Option<Candidate>,
    /// Android: the verified APK waiting for the install permission / the system prompt.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    apk: Option<std::path::PathBuf>,
}

fn busy(p: UpdatePhase) -> bool {
    matches!(p, UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Installing)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
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
            state: Mutex::new(State { status, candidate: None, apk: None }),
            launch_checked: AtomicBool::new(false),
        })
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
        })
    }

    /// `core_call` entry for [`METHODS`].
    pub async fn call(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, ApiError> {
        let status = match AppMethod::parse(method, params)? {
            AppMethod::AppUpdateStatus(_) => self.status(),
            AppMethod::AppUpdateCheck(p) => self.check(p).await,
            AppMethod::AppUpdateInstall(_) => self.install()?,
            m => return Err(ApiError::new("unknown_method", format!("{} is not an update method", m.name()))),
        };
        serde_json::to_value(status).map_err(|e| ApiError::new("internal", e.to_string()))
    }

    /// `settings.autoUpdate`; settings that can't be read count as off (never install unasked).
    async fn auto_update_enabled(&self) -> bool {
        match self.core.engine.call(None, "settings.get", Value::Null).await {
            Ok(v) => serde_json::from_value::<Settings>(v).is_ok_and(|s| s.auto_update),
            Err(e) => {
                log::warn!("update: can't read settings ({e}); skipping the launch update");
                false
            }
        }
    }

    /// Looks for a newer release; resolves once discovery is done (the install, if any, runs on).
    pub async fn check(self: &Arc<Self>, p: UpdateCheckParams) -> UpdateStatus {
        let Some(target) = self.target else { return self.status() };
        let install = if p.launch {
            if self.launch_checked.swap(true, Ordering::AcqRel) || !self.auto_update_enabled().await {
                return self.status();
            }
            true
        } else {
            p.install
        };
        {
            let mut s = self.lock();
            if busy(s.status.phase) {
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
                });
            }
        };
        let available = found.is_some();
        match &found {
            Some(c) => log::info!("update: {} available (running {})", c.tag, self.current),
            None => log::info!("update: {} is up to date", self.current),
        }
        let status = self.update(|s| {
            s.status.phase = if available { UpdatePhase::Available } else { UpdatePhase::UpToDate };
            s.status.latest = found.as_ref().map(|c| c.version.to_string());
            s.status.checked_at = Some(now_ms());
            s.candidate = found;
        });
        // Manual platforms only report the new version; the user downloads it (install()).
        if available && install && !status.manual { self.install().unwrap_or(status) } else { status }
    }

    /// Starts downloading + installing the release found by the last check. Manual platforms
    /// (macOS): opens the release's package in the browser instead and stays `available`.
    pub fn install(self: &Arc<Self>) -> Result<UpdateStatus, ApiError> {
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
            if let Err(e) = me.run_install(&candidate).await {
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

    async fn run_install(self: &Arc<Self>, c: &Candidate) -> Result<(), String> {
        match &c.assets {
            #[cfg(desktop)]
            release::Assets::Manifest { manifest_url } => self.install_plugin(manifest_url, &c.version).await,
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
    async fn install_plugin(self: &Arc<Self>, manifest_url: &str, version: &Version) -> Result<(), String> {
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
        self.update(|s| {
            s.status.phase = UpdatePhase::Installing;
            s.status.progress = None;
        });
        // Windows: starts the passive installer (it relaunches TeleFlock) and exits the process.
        // Linux: replaces the AppImage or runs `pkexec dpkg -i` (which waits for the password
        // prompt). Off the async workers: both block.
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        // Not reached on Windows. Elsewhere the new version is on disk: restart into it through
        // the regular exit path (RunEvent::Exit → engine shutdown).
        log::info!("update: installed, restarting");
        self.app.request_restart();
        Ok(())
    }

    #[cfg(target_os = "android")]
    async fn install_android(self: &Arc<Self>, apk_name: &str, apk_url: &str, sha256_url: &str) -> Result<(), String> {
        use tauri::Manager;
        let client = net::client(&self.user_agent)?;
        let sha256 = net::sha256_of(&client, sha256_url).await?;
        // Cache dir = Context.getCacheDir(), exposed by the app's FileProvider (`res/xml/file_paths.xml`).
        let dest = self.app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates").join(apk_name);
        net::download_verified(&client, apk_url, &dest, &sha256, self.progress()).await?;
        self.lock().apk = Some(dest);
        self.launch_apk(true)
    }

    /// Hands the verified APK to the system installer. The plugin first checks the archive
    /// itself (same package, same signing certificates, higher versionCode) and deletes it when
    /// it doesn't match. Without the "install unknown apps" permission, opens its settings screen
    /// (`open_settings`) and waits for [`Self::resumed`].
    #[cfg(target_os = "android")]
    fn launch_apk(&self, open_settings: bool) -> Result<(), String> {
        use tauri_plugin_teleflock_android::{ApkInstall, TeleFlockAndroidExt};
        let path = self.lock().apk.clone().ok_or("no downloaded update")?;
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
    /// installer). A granted permission continues the install; a dismissed installer leaves the
    /// update available (a completed install replaces this process instead).
    #[cfg(target_os = "android")]
    pub fn resumed(self: &Arc<Self>) {
        match self.status().phase {
            UpdatePhase::NeedsPermission => {
                let me = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = me.launch_apk(false) {
                        me.fail(e);
                    }
                });
            }
            UpdatePhase::Installing => {
                self.update(|s| s.status.phase = UpdatePhase::Available);
            }
            _ => {}
        }
    }
}
