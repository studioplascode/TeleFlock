use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use tf_client::{Engine, EngineConfig};
use tf_devserver::{DevPlatform, router, serve};

/// WebSocket bridge exposing the TeleFlock app core to a browser, plus the built UI.
#[derive(Parser, Debug)]
#[command(name = "tf-devserver", version)]
struct Args {
    /// Address to listen on. Anything but loopback exposes full control of your hosts.
    #[arg(long, default_value = "127.0.0.1:7420")]
    bind: String,
    /// App data directory (hosts.json, settings.json, cache/).
    #[arg(long)]
    data_dir: PathBuf,
    /// Serve this directory (the built UI, `dist/`) with an index.html SPA fallback.
    #[arg(long = "static")]
    static_dir: Option<PathBuf>,
    /// Deploy this tf-hostd instead of the embedded ones (a binary, or a dist dir of
    /// `<triple>/tf-hostd`).
    #[arg(long)]
    hostd_bin: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = Args::parse();
    if let Some(dir) = &args.static_dir
        && !dir.join("index.html").is_file()
    {
        log::warn!("{} has no index.html (build the UI with `bun run build`)", dir.display());
    }
    let (engine, startup_events) = Engine::start(
        EngineConfig {
            data_dir: args.data_dir.clone(),
            platform_name: std::env::consts::OS.to_string(),
            client_app: "teleflock-devserver".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            hostd_bins_override: args.hostd_bin.clone(),
        },
        Arc::new(DevPlatform),
    )
    .await;
    // WS clients use `subscribe_with_replay`; don't retain an unread receiver.
    drop(startup_events);
    let listener = tokio::net::TcpListener::bind(&args.bind).await?;
    let addr = listener.local_addr()?;
    if !addr.ip().is_loopback() {
        log::warn!("listening on {addr}: every client that can reach it controls your hosts");
    }
    log::info!("tf-devserver on http://{addr}/ (ws://{addr}/ws), data {}", args.data_dir.display());
    let app = router(engine.clone(), args.static_dir);
    tokio::select! {
        r = serve(listener, app) => r?,
        _ = tokio::signal::ctrl_c() => log::info!("shutting down"),
    }
    engine.shutdown().await;
    Ok(())
}
