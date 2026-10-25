//! Manual transport probe, for verifying against real hosts (e.g. a Tailscale SSH peer).
//!
//! ```text
//! cargo run -p tf-transport --example probe -- ssh <address> [--port N] [--user U] [--known-hosts PATH] [--forward HOST:PORT] -- <argv…>
//! cargo run -p tf-transport --example probe -- local -- <argv…>
//! cargo run -p tf-transport --example probe -- wsl [--distro D] -- <argv…>
//! ```
//! Prints every `TransportEvent` with a timestamp, runs `argv` via `exec`, optionally
//! sends an HTTP GET through `forward_tcp`, then closes the transport.

use std::time::{Duration, Instant};

use tf_transport::{Cmd, ConnectOptions, HostKind, HostProfile, connect};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn usage() -> ! {
    eprintln!("usage: probe (ssh <address> [--port N] [--user U] [--known-hosts P] [--forward H:P] | local | wsl [--distro D]) -- <argv…>");
    std::process::exit(2)
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let split = args.iter().position(|a| a == "--").unwrap_or(args.len());
    let (opts_args, argv) = (&args[..split], args.get(split + 1..).unwrap_or(&[]).to_vec());
    let mut it = opts_args.iter();
    let kind = match it.next().map(String::as_str) {
        Some("ssh") => HostKind::TailscaleSsh,
        Some("local") => HostKind::Local,
        Some("wsl") => HostKind::Wsl,
        _ => usage(),
    };
    let mut profile = HostProfile {
        id: "probe".into(),
        name: "probe".into(),
        kind,
        address: None,
        user: None,
        port: None,
        distro: None,
        herdr_session: "default".into(),
        color: None,
        auto_connect: false,
        relay_port: None,
        group: None,
    };
    let mut known_hosts = std::env::temp_dir().join("tf-probe-known_hosts");
    let mut forward: Option<(String, u16)> = None;
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().unwrap_or_else(|| usage());
        match a.as_str() {
            "--port" => profile.port = Some(val().parse().unwrap_or_else(|_| usage())),
            "--user" => profile.user = Some(val()),
            "--distro" => profile.distro = Some(val()),
            "--known-hosts" => known_hosts = val().into(),
            "--forward" => {
                let v = val();
                let (h, p) = v.rsplit_once(':').unwrap_or_else(|| usage());
                forward = Some((h.to_owned(), p.parse().unwrap_or_else(|_| usage())));
            }
            addr if profile.address.is_none() && !addr.starts_with("--") => profile.address = Some(addr.to_owned()),
            _ => usage(),
        }
    }

    let t0 = Instant::now();
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            println!("[{:>8.3}s] event {ev:?}", t0.elapsed().as_secs_f64());
        }
    });
    let opts = ConnectOptions::new(&known_hosts);
    let t = match connect(&profile, &opts, tx).await {
        Ok(t) => t,
        Err(e) => {
            let api: tf_proto::ApiError = e.clone().into();
            println!("[{:>8.3}s] connect failed: {e}\n  code={} hint={:?}", t0.elapsed().as_secs_f64(), api.code, api.hint);
            tokio::time::sleep(Duration::from_millis(100)).await;
            std::process::exit(1);
        }
    };
    println!("[{:>8.3}s] connected ({:?})", t0.elapsed().as_secs_f64(), t.kind());
    if !argv.is_empty() {
        match t.exec(&Cmd::new(argv.clone()).timeout(Duration::from_secs(60))).await {
            Ok(out) => println!(
                "[{:>8.3}s] exec {argv:?}: {}\n--- stdout ---\n{}--- stderr ---\n{}",
                t0.elapsed().as_secs_f64(),
                out.status,
                out.stdout_str(),
                out.stderr_str()
            ),
            Err(e) => println!("[{:>8.3}s] exec failed: {e}", t0.elapsed().as_secs_f64()),
        }
    }
    if let Some((h, p)) = forward {
        match t.forward_tcp(&h, p).await {
            Ok(mut s) => {
                let _ = s.write_all(format!("GET / HTTP/1.0\r\nHost: {h}\r\n\r\n").as_bytes()).await;
                let mut buf = vec![0u8; 512];
                let n = tokio::time::timeout(Duration::from_secs(10), s.read(&mut buf)).await.ok().and_then(Result::ok).unwrap_or(0);
                let first = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or_default().to_owned();
                println!("[{:>8.3}s] forward {h}:{p}: {n} bytes, first line {first:?}", t0.elapsed().as_secs_f64());
            }
            Err(e) => println!("[{:>8.3}s] forward {h}:{p} failed: {e}", t0.elapsed().as_secs_f64()),
        }
    }
    t.close().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
}
