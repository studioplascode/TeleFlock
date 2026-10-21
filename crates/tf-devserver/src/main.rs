use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use tf_client::{Engine, EngineConfig};
use tf_devserver::access::{self, Access};
use tf_devserver::{DevPlatform, Keepalive, router, serve};

/// WebSocket bridge exposing the TeleFlock app core to a browser, plus the built UI.
#[derive(Parser, Debug)]
#[command(name = "tf-devserver", version)]
struct Args {
    /// Address to listen on. Non-loopback addresses need --allow-remote.
    #[arg(long, default_value = "127.0.0.1:7420")]
    bind: String,
    /// Allow listening on a non-loopback address. Anyone who can reach it and has the token
    /// controls every host.
    #[arg(long)]
    allow_remote: bool,
    /// Access token for /ws (default: random per launch). At least 22 chars of [A-Za-z0-9_-].
    #[arg(long)]
    token: Option<String>,
    /// Extra accepted Host header: `name` (any port) or `name:port`. Repeatable. The bind
    /// address, localhost and loopback IPs on the bound port are always accepted.
    #[arg(long = "allow-host", value_name = "NAME[:PORT]")]
    allow_hosts: Vec<String>,
    /// Extra Origin allowed to open /ws (e.g. `http://localhost:5173` for a `vite dev` UI using
    /// `?core=`). Repeatable. The served origin is always allowed.
    #[arg(long = "allow-origin", value_name = "ORIGIN")]
    allow_origins: Vec<String>,
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

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("tf-devserver: {msg}");
    std::process::exit(2);
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
    let token = match args.token.clone() {
        Some(t) => t,
        None => access::generate_token().unwrap_or_else(|e| fail(format!("cannot generate a token: {e}"))),
    };
    let listener = tokio::net::TcpListener::bind(&args.bind).await?;
    let addr = listener.local_addr()?;
    if let Err(e) = access::check_bind(addr, args.allow_remote) {
        fail(e);
    }
    let access = Access::new(token, addr, &args.allow_hosts, &args.allow_origins).unwrap_or_else(|e| fail(e));
    if !addr.ip().is_loopback() {
        log::warn!("listening on {addr}: every client that can reach it and has the token controls your hosts");
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
    log::info!("tf-devserver data {}", args.data_dir.display());
    let tok = access.token();
    println!("tf-devserver on http://{addr}/?token={tok} (ws://{addr}/ws?token={tok})");
    let app = router(engine.clone(), args.static_dir, access, Keepalive::default());
    tokio::select! {
        r = serve(listener, app) => r?,
        _ = tokio::signal::ctrl_c() => log::info!("shutting down"),
    }
    engine.shutdown().await;
    Ok(())
}
