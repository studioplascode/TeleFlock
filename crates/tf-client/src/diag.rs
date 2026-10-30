//! `hosts.test`: step-by-step connection diagnostics with timings. Uses a fresh transport and
//! never modifies the host (it does not deploy; `attach` runs only when the deployed
//! tf-hostd already matches this app).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tf_proto::{
    ApiError, ClientInfo, ClientMsg, DiagReport, DiagStatus, DiagStep, HostKind, HostProfile, HostSecrets, HostState,
    PROTOCOL_VERSION, ServerMsg, SshAuth, StatePatch,
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

/// Finds a tool like tf-hostd does and runs `<tool> --version` (POSIX sh, so a fish login shell
/// works too): the login PATH, then the well-known install dirs, then (bounded to 6 s) the PATH
/// of the user's interactive shell, where bun's and nvm's installers add theirs. That shell only
/// runs the line every shell reads alike, handing the printf to `sh` in `$TF_EXEC` (hostd
/// `userenv::interactive_path`; csh and tcsh without `-l`). Prints tagged lines (login shells may
/// print noise): `tf.missing=1`, or `tf.path`, `tf.via`, `tf.code`, `tf.out`.
const TOOL_PROBE: &str = r#"tool=$1
found() { command -v "$tool" 2>/dev/null; }
via=login
bin=$(found)
if [ -z "$bin" ]; then
  PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.npm-global/bin:$HOME/bin:$HOME/.deno/bin:$HOME/.volta/bin:$HOME/.local/share/mise/shims:$HOME/.asdf/shims:$HOME/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/opt/homebrew/bin"
  via=wellknown
  bin=$(found)
fi
if [ -z "$bin" ] && [ -n "$SHELL" ] && [ -x "$SHELL" ]; then
  f=$(mktemp 2>/dev/null || echo "/tmp/tf-diag-path.$$")
  set -- -i -l -c
  case ${SHELL##*/} in csh|tcsh) set -- -i -c ;; esac
  TF_EXEC="printf '%s' '__TF_PATH_' 'BEGIN__' \"\$PATH\" '__TF_PATH_' 'END__'" "$SHELL" "$@" 'exec sh -c '\''eval "$TF_EXEC"'\''' </dev/null >"$f" 2>/dev/null &
  p=$!
  ( sleep 6; kill -9 "$p" ) </dev/null >/dev/null 2>&1 &
  k=$!
  wait "$p" 2>/dev/null
  kill "$k" 2>/dev/null
  out=$(cat "$f" 2>/dev/null)
  rm -f "$f"
  case $out in
    *__TF_PATH_BEGIN__*__TF_PATH_END__*)
      ip=${out#*__TF_PATH_BEGIN__}
      PATH="${ip%%__TF_PATH_END__*}:$PATH"
      via=interactive
      bin=$(found) ;;
  esac
fi
if [ -z "$bin" ]; then
  echo "tf.missing=1"
  exit 0
fi
echo "tf.path=$bin"
echo "tf.via=$via"
out=$("$bin" --version 2>&1)
echo "tf.code=$?"
printf '%s\n' "$out" | sed -n '/[^[:space:]]/{s/^/tf.out=/p;q;}'
"#;

/// What [`TOOL_PROBE`] found.
#[derive(Debug, Default, PartialEq)]
struct ToolProbe {
    /// `None`: not found anywhere.
    path: Option<String>,
    /// `login`, `wellknown` or `interactive`.
    via: String,
    code: Option<i32>,
    /// First line `--version` printed (stdout and stderr).
    out: String,
}

fn parse_tool_probe(stdout: &str) -> Option<ToolProbe> {
    let mut p = ToolProbe::default();
    let mut seen = false;
    for line in stdout.lines() {
        let Some((k, v)) = line.trim_end_matches('\r').strip_prefix("tf.").and_then(|r| r.split_once('=')) else { continue };
        seen = true;
        match k {
            "path" => p.path = Some(v.to_string()),
            "via" => p.via = v.to_string(),
            "code" => p.code = v.trim().parse().ok(),
            "out" => p.out = v.trim().to_string(),
            _ => {}
        }
    }
    seen.then_some(p)
}

/// The step for one probed tool.
fn tool_step(bin: &str, p: &ToolProbe) -> (DiagStatus, String) {
    let Some(path) = &p.path else {
        return (
            DiagStatus::Warn,
            format!(
                "not installed (not on the login PATH, in ~/.local/bin, ~/.bun/bin and the other usual dirs, or on your interactive shell's PATH); TeleFlock can install {bin} from Host setup once the host is added"
            ),
        );
    };
    let found = match p.via.as_str() {
        "wellknown" => " (outside the login PATH; tf-hostd looks there too)",
        "interactive" => " (only on your interactive shell's PATH; tf-hostd uses that PATH)",
        _ => "",
    };
    match p.code {
        Some(0) => (DiagStatus::Ok, format!("{} · {path}{found}", p.out)),
        _ => {
            let why = if p.out.is_empty() { format!("`{bin} --version` failed") } else { p.out.clone() };
            let hint = if why.contains("env") && why.contains("No such file") {
                "; its interpreter is missing: Host setup can install it once the host is added"
            } else {
                ""
            };
            (DiagStatus::Fail, format!("{path}{found}: {why}{hint}"))
        }
    }
}

async fn version_step(t: &dyn Transport, steps: &mut Steps, id: &str, label: &str, bin: &str, host_os: &str) {
    let start = Instant::now();
    // Windows (Local kind on Windows): no POSIX shell; run it directly.
    if host_os == "windows" {
        let r = t.exec(&Cmd::new([bin, "--version"]).timeout(Duration::from_secs(20))).await;
        let ms = Some(start.elapsed());
        return match r {
            Ok(out) if out.status.success() => steps.push(id, label, DiagStatus::Ok, Some(first_line(&out.stdout)), ms),
            Ok(out) => {
                let err = first_line(&out.stderr);
                steps.push(id, label, DiagStatus::Fail, Some(if err.is_empty() { format!("`{bin} --version` failed") } else { err }), ms)
            }
            Err(e) => {
                let detail = format!("{}; TeleFlock can install {bin} from Host setup once the host is added", ApiError::from(e).message);
                steps.push(id, label, DiagStatus::Warn, Some(detail), ms)
            }
        };
    }
    let r = t.exec(&Cmd::new(["sh", "-c", TOOL_PROBE, "sh", bin]).timeout(Duration::from_secs(30))).await;
    let ms = Some(start.elapsed());
    match r {
        Ok(out) => match parse_tool_probe(&String::from_utf8_lossy(&out.stdout)) {
            Some(p) => {
                let (status, detail) = tool_step(bin, &p);
                steps.push(id, label, status, Some(detail), ms)
            }
            None => {
                let err = first_line(&out.stderr);
                steps.push(id, label, DiagStatus::Fail, Some(if err.is_empty() { format!("couldn't look for {bin}") } else { err }), ms)
            }
        },
        Err(e) => steps.push(id, label, DiagStatus::Fail, Some(ApiError::from(e).message), ms),
    }
}

/// `secrets`: what password / key sign-in uses (the saved ones, or those typed in the editor).
pub(crate) async fn run(eng: &Arc<Inner>, profile: HostProfile, secrets: HostSecrets) -> DiagReport {
    let mut steps = Steps(Vec::new());
    let remote = profile.kind == HostKind::TailscaleSsh;
    let method = crate::secrets::method(&profile);
    let (ssh_label, auth_label) = match profile.kind {
        HostKind::TailscaleSsh => (
            "SSH connection".to_string(),
            match method {
                SshAuth::Tailscale => "Tailscale SSH auth".to_string(),
                SshAuth::Password => "Password sign-in".to_string(),
                SshAuth::Key => format!("Key sign-in ({})", profile.key_path.as_deref().unwrap_or("saved key")),
            },
        ),
        HostKind::Wsl => (format!("Start WSL ({})", profile.distro.clone().unwrap_or_default()), "Authentication".to_string()),
        _ => ("Local process".to_string(), "Authentication".to_string()),
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
                    Some(format!("{e} ({})", if method == SshAuth::Tailscale { "is Tailscale up on this device?" } else { "check the host name" })),
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
    opts.secrets = secrets;
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

    version_step(t, &mut steps, "herdr", "herdr", "herdr", &probe.os).await;
    version_step(t, &mut steps, "omp", "omp", "omp", &probe.os).await;

    // hostd
    let expected = expected_version_line();
    let start = Instant::now();
    let artifact = eng.artifacts().hostd(&probe.os, &probe.arch).await;
    let up_to_date = match &artifact {
        _ if deploy::host_is_newer(&probe.version) => {
            let detail = format!("{} installed by a newer TeleFlock; used as is (this app ships {expected})", probe.version);
            steps.push("hostd", "tf-hostd", DiagStatus::Warn, Some(detail), Some(start.elapsed()));
            true
        }
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
                features: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_steps() {
        let noisy = "Welcome!\ntf.path=/home/u/.bun/bin/omp\ntf.via=wellknown\ntf.code=0\ntf.out=omp/18.13.1\r\n";
        let p = parse_tool_probe(noisy).unwrap();
        assert_eq!(p, ToolProbe { path: Some("/home/u/.bun/bin/omp".into()), via: "wellknown".into(), code: Some(0), out: "omp/18.13.1".into() });
        assert_eq!(tool_step("omp", &p), (DiagStatus::Ok, "omp/18.13.1 · /home/u/.bun/bin/omp (outside the login PATH; tf-hostd looks there too)".into()));

        let broken = parse_tool_probe("tf.path=/home/u/.bun/bin/omp\ntf.via=login\ntf.code=127\ntf.out=/usr/bin/env: 'bun': No such file or directory\n").unwrap();
        let (status, detail) = tool_step("omp", &broken);
        assert_eq!(status, DiagStatus::Fail);
        assert!(detail.starts_with("/home/u/.bun/bin/omp: /usr/bin/env: 'bun'") && detail.contains("Host setup can install it"), "{detail}");

        let (status, detail) = tool_step("herdr", &parse_tool_probe("tf.missing=1\n").unwrap());
        assert_eq!(status, DiagStatus::Warn);
        assert!(detail.contains("TeleFlock can install herdr from Host setup once the host is added"), "{detail}");
        assert_eq!(parse_tool_probe("sh: 1: syntax error\n"), None);
    }

    #[cfg(unix)]
    fn probe(home: &std::path::Path, shell: Option<&std::path::Path>, tool: &str) -> ToolProbe {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", TOOL_PROBE, "sh", tool]).env("HOME", home).env("PATH", "/usr/bin:/bin").env_remove("SHELL");
        if let Some(shell) = shell {
            cmd.env("SHELL", shell);
        }
        let out = cmd.output().unwrap();
        parse_tool_probe(&String::from_utf8_lossy(&out.stdout)).unwrap_or_else(|| panic!("{}", String::from_utf8_lossy(&out.stderr)))
    }

    #[cfg(unix)]
    #[test]
    fn tool_probe_script_finds_tools_like_hostd() {
        let td = tempfile::tempdir().unwrap();
        let exe = |path: std::path::PathBuf, body: &str| tf_hostd::test_exe::write_exe(&path, body);
        // An `env`-style script in ~/.bun/bin whose interpreter lives there too.
        exe(td.path().join(".bun/bin/tfdiag-runtime"), "#!/bin/sh\nshift\necho 'tfdiag 1.2.3'\n");
        exe(td.path().join(".bun/bin/tfdiag-tool"), "#!/usr/bin/env tfdiag-runtime\n");
        let p = probe(td.path(), None, "tfdiag-tool");
        assert_eq!((p.via.as_str(), p.code, p.out.as_str()), ("wellknown", Some(0), "tfdiag 1.2.3"), "{p:?}");
        assert_eq!(p.path.as_deref(), Some(td.path().join(".bun/bin/tfdiag-tool").to_str().unwrap()));

        // Only the interactive shell's PATH has it.
        exe(td.path().join("nvm/bin/tfdiag-node"), "#!/bin/sh\necho v22.1.0\n");
        let shell = td.path().join("fake-shell");
        exe(shell.clone(), &format!("#!/bin/sh\necho 'motd'\nshift 3\nPATH={}:/usr/bin:/bin\neval \"$1\"\n", td.path().join("nvm/bin").display()));
        let p = probe(td.path(), Some(&shell), "tfdiag-node");
        assert_eq!((p.via.as_str(), p.code, p.out.as_str()), ("interactive", Some(0), "v22.1.0"), "{p:?}");

        // Nowhere; a shell that never prints its PATH is cut off after 6 s at most.
        let hung = td.path().join("hung-shell");
        exe(hung.clone(), "#!/bin/sh\nexec sleep 30\n");
        let started = Instant::now();
        assert_eq!(probe(td.path(), Some(&hung), "tfdiag-absent").path, None);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// The interactive shell only has to run the line every shell reads alike, as hostd asks it:
    /// a `nu` that refuses any other line and a `tcsh` asked without `-l`, plus real shells from
    /// `TF_TEST_LOGIN_SHELLS` (fish, nushell, zsh, tcsh …), each with its own rc file.
    #[cfg(unix)]
    #[test]
    fn tool_probe_reads_the_interactive_path_of_any_shell() {
        let td = tempfile::tempdir().unwrap();
        let home = td.path().join("home");
        let write = |path: std::path::PathBuf, body: &str, mode: u32| tf_hostd::test_exe::write(&path, body, mode);
        write(home.join("ishell/bin/tfdiag-node"), "#!/bin/sh\necho v22.1.0\n", 0o755);
        write(home.join(".config/fish/config.fish"), "set -gx PATH $HOME/ishell/bin $PATH\n", 0o644);
        write(home.join(".config/nushell/env.nu"), "$env.PATH = ($env.PATH | prepend ($env.HOME | path join 'ishell/bin'))\n", 0o644);
        write(home.join(".config/nushell/config.nu"), "", 0o644);
        write(home.join(".zshrc"), "PATH=$HOME/ishell/bin:$PATH\n", 0o644);
        write(home.join(".tcshrc"), "setenv PATH $HOME/ishell/bin:$PATH\n", 0o644);
        write(home.join(".bash_profile"), "PATH=$HOME/ishell/bin:$PATH\n", 0o644);
        let line = format!("'{}'", r#"exec sh -c 'eval "$TF_EXEC"'"#.replace('\'', r"'\''"));
        let mut shells = Vec::new();
        for (name, flags, arg) in [("nu", "-i -l -c", "$4"), ("tcsh", "-i -c", "$3")] {
            let args = (1..=flags.split(' ').count()).map(|i| format!("${i}")).collect::<Vec<_>>().join(" ");
            let shell = td.path().join("fakes").join(name);
            let body = format!(
                "#!/bin/sh\nif [ \"{args}\" != \"{flags}\" ] || [ \"{arg}\" != {line} ]; then echo \"refused: $*\" >&2; exit 2; fi\nPATH=\"$HOME/ishell/bin:$PATH\"\nexec sh -c \"{arg}\"\n"
            );
            write(shell.clone(), &body, 0o755);
            shells.push(shell);
        }
        shells.extend(std::env::var("TF_TEST_LOGIN_SHELLS").unwrap_or_default().split(':').filter(|s| !s.is_empty()).map(std::path::PathBuf::from));
        for shell in shells {
            let out = std::process::Command::new("sh")
                .args(["-c", TOOL_PROBE, "sh", "tfdiag-node"])
                .env_clear()
                .env("HOME", &home)
                .env("PATH", "/usr/bin:/bin")
                .env("SHELL", &shell)
                .output()
                .unwrap();
            let p = parse_tool_probe(&String::from_utf8_lossy(&out.stdout)).unwrap_or_default();
            assert_eq!((p.via.as_str(), p.out.as_str()), ("interactive", "v22.1.0"), "{}: {p:?}", shell.display());
        }
    }
}
