//! `hosts.test`: step-by-step connection diagnostics with timings. Uses a fresh transport and
//! never modifies the host (it does not deploy; `attach` runs only when the deployed
//! tf-hostd already matches this app).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tf_proto::{
    ApiError, ClientInfo, ClientMsg, DiagReport, DiagStatus, DiagStep, HostKind, HostProfile, HostState,
    PROTOCOL_VERSION, ServerMsg, StatePatch,
};
use tf_transport::{Cmd, ConnectOptions, Transport, TransportEvent};
use tokio::sync::mpsc;

use crate::deploy::{self, expected_version_line};
use crate::engine::Inner;
use crate::link::{Link, LinkSink};

struct Steps(Vec<DiagStep>);

impl Steps {
    fn push(&mut self, id: &str, label: impl Into<String>, status: DiagStatus, detail: Option<String>, ms: Option<Duration>) {
        self.0.push(DiagStep {
            id: id.into(),
            label: label.into(),
            status,
            detail,
            ms: ms.map(|d| d.as_millis().min(u32::MAX as u128) as u32),
        });
    }
    fn skip(&mut self, id: &str, label: impl Into<String>, why: &str) {
        self.push(id, label, DiagStatus::Skip, Some(why.into()), None);
    }
}

struct CountSink(Mutex<Option<usize>>);
impl LinkSink for CountSink {
    fn snapshot(&self, _: u64, state: HostState) {
        *self.0.lock().unwrap() = Some(state.agents.len());
    }
    fn patch(&self, _: u64, _: Vec<StatePatch>) {}
    fn push(&self, _: ServerMsg) {}
    fn latency(&self, _: u32) {}
}

fn first_line(b: &[u8]) -> String {
    String::from_utf8_lossy(b).lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default().to_string()
}

async fn version_step(t: &dyn Transport, steps: &mut Steps, id: &str, label: &str, bin: &str) {
    let start = Instant::now();
    let r = t.exec(&Cmd::new([bin, "--version"]).timeout(Duration::from_secs(20))).await;
    let ms = Some(start.elapsed());
    match r {
        Ok(out) if out.status.success() => steps.push(id, label, DiagStatus::Ok, Some(first_line(&out.stdout)), ms),
        Ok(out) => {
            let err = first_line(&out.stderr);
            steps.push(
                id,
                label,
                DiagStatus::Fail,
                Some(if err.is_empty() { format!("`{bin} --version` failed") } else { err }),
                ms,
            )
        }
        Err(e) => steps.push(id, label, DiagStatus::Fail, Some(ApiError::from(e).message), ms),
    }
}

pub(crate) async fn run(eng: &Arc<Inner>, profile: HostProfile) -> DiagReport {
    let mut steps = Steps(Vec::new());
    let remote = profile.kind == HostKind::TailscaleSsh;
    let (ssh_label, auth_label) = match profile.kind {
        HostKind::TailscaleSsh => ("SSH connection".to_string(), "Tailscale SSH auth"),
        HostKind::Wsl => (format!("Start WSL ({})", profile.distro.clone().unwrap_or_default()), "Authentication"),
        _ => ("Local process".to_string(), "Authentication"),
    };

    if profile.kind == HostKind::Demo {
        return finish(steps, "demo host is simulated in the app");
    }

    // resolve
    if remote {
        let addr = profile.address.clone().unwrap_or_default();
        let start = Instant::now();
        match tokio::net::lookup_host((addr.as_str(), profile.port.unwrap_or(22))).await {
            Ok(mut it) => {
                let ip = it.next().map(|a| a.ip().to_string()).unwrap_or_default();
                steps.push("resolve", format!("Resolve {addr}"), DiagStatus::Ok, Some(ip), Some(start.elapsed()));
            }
            Err(e) => {
                steps.push(
                    "resolve",
                    format!("Resolve {addr}"),
                    DiagStatus::Fail,
                    Some(format!("{e} (is Tailscale up on this device?)")),
                    Some(start.elapsed()),
                );
                return finish(steps, "resolve failed");
            }
        }
    } else {
        steps.skip("resolve", "Resolve", "not needed for this host kind");
    }

    // ssh + auth (timed from transport phase events)
    let marks: Arc<Mutex<Vec<(tf_proto::ConnPhase, Instant)>>> = Arc::default();
    let auth_url: Arc<Mutex<Option<String>>> = Arc::default();
    let (tx, mut rx) = mpsc::channel::<TransportEvent>(32);
    {
        let marks = marks.clone();
        let auth_url = auth_url.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                match ev {
                    TransportEvent::Phase(p, _) => marks.lock().unwrap().push((p, Instant::now())),
                    TransportEvent::AuthUrl(u) => *auth_url.lock().unwrap() = Some(u),
                    _ => {}
                }
            }
        });
    }
    let mut opts = ConnectOptions::new(eng.data_dir().join("known_hosts"));
    opts.auth_timeout = Duration::from_secs(120);
    let start = Instant::now();
    let transport = tf_transport::connect(&profile, &opts, tx).await;
    let done = Instant::now();
    let auth_start = marks
        .lock()
        .unwrap()
        .iter()
        .find(|(p, _)| *p == tf_proto::ConnPhase::Authenticating)
        .map(|(_, t)| *t);
    let transport = match transport {
        Ok(t) => {
            match auth_start {
                Some(a) => {
                    steps.push("ssh", ssh_label, DiagStatus::Ok, None, Some(a - start));
                    let url = auth_url.lock().unwrap().clone();
                    steps.push(
                        "auth",
                        auth_label,
                        if url.is_some() { DiagStatus::Warn } else { DiagStatus::Ok },
                        url.map(|u| format!("check-mode re-auth was required: {u}")),
                        Some(done - a),
                    );
                }
                None => {
                    steps.push("ssh", ssh_label, DiagStatus::Ok, None, Some(done - start));
                    steps.skip("auth", auth_label, if remote { "no separate auth phase" } else { "not needed for this host kind" });
                }
            }
            t
        }
        Err(e) => {
            let e = ApiError::from(e);
            let detail = Some(match &e.hint {
                Some(h) => format!("{} — {h}", e.message),
                None => e.message.clone(),
            });
            match auth_start {
                Some(a) => {
                    steps.push("ssh", ssh_label, DiagStatus::Ok, None, Some(a - start));
                    steps.push("auth", auth_label, DiagStatus::Fail, detail, Some(done - a));
                }
                None => steps.push("ssh", ssh_label, DiagStatus::Fail, detail, Some(done - start)),
            }
            return finish(steps, "not connected");
        }
    };

    let report = after_connect(eng, &profile, &*transport, steps).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), transport.close()).await;
    report
}

async fn after_connect(eng: &Arc<Inner>, profile: &HostProfile, t: &dyn Transport, mut steps: Steps) -> DiagReport {
    // shell
    let start = Instant::now();
    let probe = match deploy::probe(t, profile.kind).await {
        Ok(p) => {
            steps.push(
                "shell",
                "Shell",
                DiagStatus::Ok,
                Some(format!("{} {} · {}", p.os, p.arch, p.home)),
                Some(start.elapsed()),
            );
            p
        }
        Err(e) => {
            steps.push("shell", "Shell", DiagStatus::Fail, Some(e.message), Some(start.elapsed()));
            return finish(steps, "shell failed");
        }
    };

    version_step(t, &mut steps, "herdr", "herdr", "herdr").await;
    version_step(t, &mut steps, "omp", "omp", "omp").await;

    // hostd
    let expected = expected_version_line();
    let start = Instant::now();
    let artifact = eng.artifacts().hostd(&probe.os, &probe.arch).await;
    let up_to_date = match &artifact {
        Err(e) => {
            steps.push("hostd", "tf-hostd", DiagStatus::Fail, Some(e.message.clone()), Some(start.elapsed()));
            false
        }
        Ok(bin) if probe.version == expected && probe.hostd_sha == bin.sha => {
            steps.push("hostd", "tf-hostd", DiagStatus::Ok, Some(probe.version.clone()), Some(start.elapsed()));
            true
        }
        Ok(_) => {
            let detail = if probe.version.is_empty() {
                format!("not installed; {expected} is deployed on connect")
            } else {
                format!("{} installed; {expected} is deployed on connect", probe.version)
            };
            steps.push("hostd", "tf-hostd", DiagStatus::Warn, Some(detail), Some(start.elapsed()));
            false
        }
    };

    // relay
    let port = profile.relay_port.unwrap_or(tf_proto::DEFAULT_RELAY_PORT);
    let start = Instant::now();
    match tokio::time::timeout(Duration::from_secs(10), t.forward_tcp("127.0.0.1", port)).await {
        Ok(Ok(_stream)) => steps.push("relay", "Collab relay", DiagStatus::Ok, Some(format!("listening on 127.0.0.1:{port}")), Some(start.elapsed())),
        Ok(Err(e)) => steps.push(
            "relay",
            "Collab relay",
            DiagStatus::Warn,
            Some(format!("not reachable on 127.0.0.1:{port} ({}); tf-hostd starts it", ApiError::from(e).message)),
            Some(start.elapsed()),
        ),
        Err(_) => steps.push("relay", "Collab relay", DiagStatus::Warn, Some(format!("127.0.0.1:{port} timed out")), Some(start.elapsed())),
    }

    // attach
    if !up_to_date {
        steps.skip("attach", "Attach", "connect once to deploy tf-hostd");
        return DiagReport { steps: steps.0 };
    }
    let start = Instant::now();
    let hostd = if profile.kind == HostKind::Local {
        std::path::Path::new(&probe.home).join("bin").join(if cfg!(windows) { "tf-hostd.exe" } else { "tf-hostd" }).to_string_lossy().into_owned()
    } else {
        format!("{}/bin/tf-hostd", probe.home)
    };
    let mut argv = vec![hostd, "attach".into(), "--session".into(), profile.herdr_session.clone()];
    if let Some(p) = profile.relay_port {
        argv.extend(["--relay-port".into(), p.to_string()]);
    }
    let r = async {
        let mut child = t.spawn(&Cmd::new(argv)).await.map_err(ApiError::from)?;
        let (Some(i), Some(o)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(ApiError::new("internal", "attach has no stdio"));
        };
        let sink = Arc::new(CountSink(Mutex::new(None)));
        let hello = ClientMsg::Hello {
            protocol: PROTOCOL_VERSION,
            client: ClientInfo {
                app: eng.cfg.client_app.clone(),
                version: eng.cfg.version.clone(),
                platform: eng.cfg.platform_name.clone(),
                device: format!("{} (diagnostics)", eng.device_name()),
            },
            herdr_session: profile.herdr_session.clone(),
        };
        let link = Link::establish(i, o, child.stderr.take(), hello, sink.clone()).await;
        let res = link.map(|l| {
            l.bye();
            l.close("diagnostics done");
            format!(
                "hostd {} · session {} · {} agents",
                l.hostd_version,
                profile.herdr_session,
                sink.0.lock().unwrap().unwrap_or(0)
            )
        });
        // Let attach exit after `bye`; dropping the child kills it otherwise.
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
        drop(child);
        res
    }
    .await;
    match r {
        Ok(d) => steps.push("attach", "Attach", DiagStatus::Ok, Some(d), Some(start.elapsed())),
        Err(e) => steps.push("attach", "Attach", DiagStatus::Fail, Some(e.message), Some(start.elapsed())),
    }
    DiagReport { steps: steps.0 }
}

/// Marks every step that did not run as skipped.
fn finish(mut steps: Steps, why: &str) -> DiagReport {
    let all = [
        ("resolve", "Resolve"),
        ("ssh", "Connect"),
        ("auth", "Auth"),
        ("shell", "Shell"),
        ("herdr", "herdr"),
        ("omp", "omp"),
        ("hostd", "tf-hostd"),
        ("relay", "Collab relay"),
        ("attach", "Attach"),
    ];
    for (id, label) in all {
        if !steps.0.iter().any(|s| s.id == id) {
            steps.skip(id, label, why);
        }
    }
    DiagReport { steps: steps.0 }
}
