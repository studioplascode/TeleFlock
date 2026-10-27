//! TeleFlock app shell: embeds the `tf_client` engine and wires it to the webview and the OS
//! (tray, taskbar, toasts, deep links, single instance on desktop; foreground service,
//! notifications, haptics on Android).

#[cfg(desktop)]
mod badge;
mod core;
mod deeplink;
mod platform;
mod present;
#[cfg(windows)]
mod toast;
#[cfg_attr(not(windows), allow(dead_code))]
mod toastxml;
#[cfg(desktop)]
mod tray;
mod update;

use std::sync::Arc;

use tauri::{App, AppHandle, Manager, RunEvent, Wry, webview::PageLoadEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tf_client::{Engine, EngineConfig, Resume};
use tf_proto::AppEvent;

use crate::core::{Core, CoreState};
use crate::deeplink::Link;
use crate::platform::{Shell, TauriPlatform};

const PLATFORM_NAME: &str = if cfg!(target_os = "android") {
    "android"
} else if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

const CLIENT_APP: &str = if cfg!(mobile) { "teleflock-android" } else { "teleflock-desktop" };

/// Brings the main window forward (desktop); the Android activity is already in front.
fn reveal(app: &AppHandle<Wry>) {
    #[cfg(desktop)]
    tray::show_main(app);
    #[cfg(mobile)]
    let _ = app;
}

fn handle_link(app: &AppHandle<Wry>, url: &tauri::Url) {
    let Some(link) = deeplink::parse(url) else { return };
    let Some(core) = app.try_state::<CoreState>() else { return };
    reveal(app);
    match link {
        Link::Agent { host_id, notification_id: Some(n), .. } => core.notification_action(host_id, n, None, None),
        Link::Agent { host_id, agent_id, notification_id: None } => core.ui_intent(AppEvent::OpenAgent { host_id, agent_id }),
        Link::AnswerNext => core.ui_intent(AppEvent::AnswerNext),
        Link::Open => {}
    }
}

fn setup(app: &mut App<Wry>) -> Result<(), Box<dyn std::error::Error>> {
    app.handle().plugin(
        tauri_plugin_log::Builder::default()
            .level(if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info })
            .max_file_size(2_000_000)
            .build(),
    )?;

    let handle = app.handle().clone();
    let shell = Arc::new(Shell::default());
    let platform = Arc::new(TauriPlatform::new(handle.clone(), Arc::clone(&shell)));
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let cfg = EngineConfig {
        data_dir,
        platform_name: PLATFORM_NAME.to_owned(),
        client_app: CLIENT_APP.to_owned(),
        version: app.package_info().version.to_string(),
        // Dev override: a tf-hostd binary or a dist dir (`<triple>/tf-hostd[.exe]`). Debug builds
        // only: in release an environment variable must never swap the binary deployed to every host.
        hostd_bins_override: if cfg!(debug_assertions) {
            std::env::var_os("TF_HOSTD_BIN").map(std::path::PathBuf::from)
        } else {
            None
        },
    };
    let (engine, initial) = tauri::async_runtime::block_on(Engine::start(cfg, platform.clone()));
    let core = Core::new(engine, initial);
    app.manage(Arc::clone(&core));
    app.manage(Arc::clone(&platform));
    let updater = update::Updater::new(handle.clone(), Arc::clone(&core));
    updater.start();
    app.manage(updater);

    #[cfg(windows)]
    {
        let icon = app.path().app_local_data_dir().ok().and_then(|dir| {
            let path = dir.join("teleflock-toast.png");
            std::fs::create_dir_all(&dir).ok()?;
            std::fs::write(&path, include_bytes!("../icons/128x128.png")).ok()?;
            Some(path)
        });
        let sink_core = Arc::clone(&core);
        let toasts = toast::Toasts::new(
            &app.config().identifier,
            app.config().product_name.as_deref().unwrap_or("TeleFlock"),
            icon.as_deref(),
            Arc::new(move |ev| match ev {
                toast::ToastEvent::Activated { host_id, notification_id, action_id, reply } => {
                    sink_core.notification_action(host_id, notification_id, action_id, reply)
                }
                toast::ToastEvent::Dismissed { host_id, notification_id } => {
                    sink_core.engine.notification_dismissed(&host_id, &notification_id)
                }
            }),
        );
        let _ = shell.toasts.set(toasts);
    }

    #[cfg(desktop)]
    {
        let tray = tray::Tray::install(&handle)?;
        tray.update(platform.badge());
        let _ = shell.tray.set(Arc::clone(&tray));
        watch_motion(Arc::clone(&core), tray);
    }

    // Deep links: cold start (argv on desktop, launch intent on Android) and warm.
    #[cfg(all(debug_assertions, windows))]
    if let Err(e) = app.deep_link().register_all() {
        log::warn!("registering teleflock:// for this dev build failed: {e}");
    }
    // Linux: the .deb / Arch package's desktop file declares the scheme; an AppImage has none
    // installed, so it registers itself (a `~/.local/share/applications` handler pointing at
    // the AppImage path, refreshed on every launch in case the file moved).
    #[cfg(target_os = "linux")]
    if app.env().appimage.is_some()
        && let Err(e) = app.deep_link().register_all()
    {
        log::warn!("registering teleflock:// for this AppImage failed: {e}");
    }
    let link_app = handle.clone();
    app.deep_link().on_open_url(move |e| {
        for url in e.urls() {
            handle_link(&link_app, &url);
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            handle_link(&handle, &url);
        }
    }
    Ok(())
}

/// Keeps the tray and taskbar animation in line with the user's motion preference: only Lively
/// (`full`) animates them; Calm (`system`, the default) and Reduced keep them still.
#[cfg(desktop)]
fn watch_motion(core: CoreState, tray: Arc<tray::Tray<Wry>>) {
    use tf_proto::{MotionPref, Settings};
    let lively = |s: &Settings| s.motion == MotionPref::Full;
    tauri::async_runtime::spawn(async move {
        let mut rx = core.engine.subscribe();
        if let Ok(v) = core.engine.call(None, "settings.get", serde_json::Value::Null).await
            && let Ok(s) = serde_json::from_value::<Settings>(v)
        {
            tray.set_lively(lively(&s));
        }
        loop {
            match rx.recv().await {
                Ok(AppEvent::Settings { settings }) => tray.set_lively(lively(&settings)),
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Process teardown: `RunEvent::Exit`, and the Windows updater right before it runs the
/// installer and exits the process (no `RunEvent::Exit` then).
fn before_exit(app: &AppHandle<Wry>) {
    #[cfg(windows)]
    if let Some(p) = app.try_state::<Arc<TauriPlatform>>()
        && let Some(t) = p.shell.toasts.get()
    {
        t.clear_all();
    }
    if let Some(core) = app.try_state::<CoreState>() {
        tauri::async_runtime::block_on(core.engine.shutdown());
    }
}

/// Android: notification buttons / replies, network changes and activity lifecycle arrive over
/// JNI, independent of the WebView. Installed before the builder so a tap right after launch is
/// not lost.
#[cfg(target_os = "android")]
fn install_android_sink() -> Arc<std::sync::OnceLock<AppHandle<Wry>>> {
    use tauri_plugin_teleflock_android::NativeEvent;
    let cell: Arc<std::sync::OnceLock<AppHandle<Wry>>> = Arc::default();
    let sink_cell = Arc::clone(&cell);
    tauri_plugin_teleflock_android::set_sink(move |ev| {
        let Some(app) = sink_cell.get() else {
            // Cold start: Tauri is about to create the window itself, and resumes don't matter yet.
            if !matches!(ev, NativeEvent::ActivityResumed { .. }) {
                log::warn!("native event before the core started: {ev:?}");
            }
            return;
        };
        if let NativeEvent::ActivityResumed { needs_window } = ev {
            // We are on the Android main thread, which must not block: windows are built, and
            // Kotlin commands wait for this thread, on the event loop (whose "main thread" this
            // is not).
            let handle = app.clone();
            if let Err(e) = app.run_on_main_thread(move || activity_resumed(&handle, needs_window)) {
                log::warn!("activity resume not handled: {e}");
            }
            return;
        }
        let Some(core) = app.try_state::<CoreState>() else {
            log::warn!("native event before the core started: {ev:?}");
            return;
        };
        match ev {
            NativeEvent::Action(a) => core.notification_action(a.host_id, a.notification_id, a.action_id, a.reply),
            NativeEvent::Dismissed(r) => core.engine.notification_dismissed(&r.host_id, &r.notification_id),
            NativeEvent::NetworkChanged => core.engine.resume(Resume::Network),
            NativeEvent::ActivityResumed { .. } => {}
        }
    });
    cell
}

/// Android: the app came to the front (`MainActivity.onResume`; Tauri's `RunEvent::Resumed`
/// never fires there). Verifies the links, retries a foreground-service start or stop refused
/// earlier, resumes a pending update install (or checks for one), and gives a new activity its
/// window back.
/// Event loop thread.
#[cfg(target_os = "android")]
fn activity_resumed(app: &AppHandle<Wry>, needs_window: bool) {
    if needs_window {
        restore_main_window(app);
    }
    if let Some(core) = app.try_state::<CoreState>() {
        core.engine.resume(Resume::Foreground);
    }
    if let Some(p) = app.try_state::<Arc<TauriPlatform>>() {
        p.sync_keep_alive();
    }
    if let Some(u) = app.try_state::<update::UpdaterState>() {
        u.resumed();
    }
}

/// Android: gives an activity without a window the main window back. Tauri creates the
/// configured windows once per process, in `setup`, but the keep-alive service keeps the process
/// running after its activity is destroyed (swiped away from recents): the next activity the
/// launcher creates had no WebView and stayed blank until a force stop (tauri-apps/tauri#15671).
/// The new window binds to that activity. Event loop thread only.
#[cfg(target_os = "android")]
fn restore_main_window(app: &AppHandle<Wry>) {
    // No state yet: `setup` has not run, and creates the window itself.
    if app.try_state::<CoreState>().is_none()
        || !app.webview_windows().is_empty()
        || !tauri_plugin_teleflock_android::has_activity()
    {
        return;
    }
    let Some(config) = app.config().app.windows.iter().find(|w| w.create).cloned() else { return };
    match tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        Ok(_) => log::info!("window '{}' restored for a new activity", config.label),
        Err(e) => log::error!("restoring window '{}' failed: {e}", config.label),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    let android_app = install_android_sink();

    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // Must be the first plugin. With the deep-link feature, a second instance's
        // `teleflock://` argv is forwarded to the deep-link plugin (→ on_open_url) here.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| tray::show_main(app)));
    }
    builder = builder.plugin(tauri_plugin_deep_link::init());
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_snap_layout::init().button_id("tf-max").build())
            // Endpoints are set per check (src/update); pubkey + install mode come from tauri.conf.json.
            .plugin(tauri_plugin_updater::Builder::new().build());
    }
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_teleflock_android::init());
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![core::core_call, core::core_term_input, core::core_events])
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started
                && let Some(core) = webview.try_state::<CoreState>()
            {
                core.page_reset();
            }
        })
        .on_window_event(|window, event| match event {
            // Desktop: closing hides to the tray; agents keep running and notifying.
            #[cfg(desktop)]
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Focused(true) => {
                // Android: `activity_resumed` tells the updater instead.
                #[cfg(desktop)]
                if let Some(u) = window.try_state::<update::UpdaterState>() {
                    u.foreground();
                }
                if let Some(core) = window.try_state::<CoreState>() {
                    // Desktop focus comes with every alt-tab: only quiet links are checked, and
                    // given longer (`Resume::Focus`). Android keeps its 5 s check of every link.
                    core.engine.resume(if cfg!(desktop) { Resume::Focus } else { Resume::Foreground });
                }
            }
            _ => {}
        })
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("error while building TeleFlock");

    #[cfg(target_os = "android")]
    let _ = android_app.set(app.handle().clone());

    app.run(|app, event| match event {
        RunEvent::ExitRequested { code: None, api, .. } => {
            // Desktop: the tray keeps the app alive. Android: the core must outlive the
            // activity while the keep-alive service runs.
            let keep = cfg!(desktop) || app.try_state::<Arc<TauriPlatform>>().is_some_and(|p| p.keep_alive_wanted());
            if keep {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => before_exit(app),
        // macOS: closing hid the window to the tray; a Dock icon click brings it back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => tray::show_main(app),
        // Android: the activity is gone, and its page with it (`on_page_load` only sees new pages).
        #[cfg(target_os = "android")]
        RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
            if let Some(core) = app.try_state::<CoreState>() {
                core.page_reset();
            }
            log::info!("window '{label}' destroyed with its activity");
            // The launcher's next activity may already be up, waiting for a window.
            restore_main_window(app);
        }
        _ => {}
    });
}
