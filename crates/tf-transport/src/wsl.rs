//! WSL transport: commands run as `wsl.exe -d <distro> --exec sh -c <login wrapper> sh <cmd>`
//! through the local process layer. `--exec` avoids an extra Windows-side shell layer; the
//! login-shell wrapper (same as SSH) puts `~/.local/bin` on PATH and applies env/cwd.
//! Previews use plain localhost (WSL2 forwards it).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::local::{self, LocalTransport};
use crate::{BoxedStream, Child, Cmd, ConnPhase, ConnectOptions, HostKind, Output, Transport, TransportError, TransportEvent, WslDistro, quote};

pub struct WslTransport {
    local: LocalTransport,
    /// `None` = the default distro.
    distro: Option<String>,
}

/// wsl.exe argv for `cmd`.
fn wsl_cmd(distro: Option<&str>, cmd: &Cmd) -> Cmd {
    let mut argv: Vec<String> = vec!["wsl.exe".into()];
    if let Some(d) = distro {
        argv.push("-d".into());
        argv.push(d.into());
    }
    argv.push("--exec".into());
    argv.extend(quote::login_shell_argv(cmd));
    Cmd { argv, env: vec![("WSL_UTF8".into(), "1".into())], cwd: None, stdin: cmd.stdin.clone(), timeout: cmd.timeout }
}

/// Decode wsl.exe's own output: UTF-16LE by default (with or without BOM), UTF-8 when
/// `WSL_UTF8=1` is honoured. Linux program output passes through as UTF-8.
pub fn decode_wsl(b: &[u8]) -> String {
    let utf16 = b.starts_with(&[0xFF, 0xFE]) || (b.len() >= 4 && b.iter().skip(1).step_by(2).take(64).all(|&x| x == 0));
    if utf16 {
        let u: Vec<u16> = b.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
        String::from_utf16_lossy(&u).trim_start_matches('\u{FEFF}').to_owned()
    } else {
        String::from_utf8_lossy(b).into_owned()
    }
}

/// Re-encode stderr as UTF-8 when it is wsl.exe's own UTF-16 message.
fn fix_stderr(mut out: Output) -> Output {
    if out.stderr.contains(&0) {
        out.stderr = decode_wsl(&out.stderr).into_bytes();
    }
    out
}

fn wsl_missing(e: TransportError) -> TransportError {
    match e {
        TransportError::Spawn { detail, .. } => TransportError::Wsl(format!("wsl.exe could not be started ({detail}). Is WSL installed?")),
        other => other,
    }
}

impl WslTransport {
    /// Warm the distro up (boots the VM if needed) and verify it exists.
    pub async fn connect(
        distro: Option<String>,
        opts: &ConnectOptions,
        events: mpsc::Sender<TransportEvent>,
    ) -> Result<Arc<Self>, TransportError> {
        let label = distro.clone().unwrap_or_else(|| "default distro".into());
        let _ = events.send(TransportEvent::Phase(ConnPhase::Connecting, Some(format!("Starting WSL ({label})…")))).await;
        let t = Self { local: LocalTransport::with_kind(HostKind::Wsl, events), distro };
        let out = t.exec(&Cmd::new(["true"]).timeout(opts.wsl_start_timeout)).await?;
        if !out.status.success() {
            let msg = format!("{}{}", decode_wsl(&out.stdout), out.stderr_str());
            return Err(TransportError::Wsl(format!("{label}: {}", msg.trim())));
        }
        Ok(Arc::new(t))
    }

    fn ensure_open(&self) -> Result<(), TransportError> {
        if self.local.is_closed() { Err(TransportError::Closed(None)) } else { Ok(()) }
    }
}

#[async_trait::async_trait]
impl Transport for WslTransport {
    async fn exec(&self, cmd: &Cmd) -> Result<Output, TransportError> {
        self.ensure_open()?;
        cmd.check()?;
        local::run(&wsl_cmd(self.distro.as_deref(), cmd)).await.map(fix_stderr).map_err(wsl_missing)
    }

    async fn spawn(&self, cmd: &Cmd) -> Result<Child, TransportError> {
        self.ensure_open()?;
        cmd.check()?;
        self.local.spawn(&wsl_cmd(self.distro.as_deref(), cmd)).await.map_err(wsl_missing)
    }

    async fn forward_tcp(&self, host: &str, port: u16) -> Result<BoxedStream, TransportError> {
        self.ensure_open()?;
        // WSL2 forwards ports bound to localhost/wildcard inside the distro to Windows' 127.0.0.1.
        let host = match host {
            "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" | "::" | "" => "127.0.0.1",
            other => other,
        };
        local::tcp(host, port).await
    }

    fn kind(&self) -> HostKind {
        HostKind::Wsl
    }

    async fn close(&self) {
        if self.local.mark_closed() {
            self.local.emit_closed().await;
        }
    }
}

/// Parse `wsl.exe -l -v` output (already decoded). Columns are `NAME STATE VERSION` with
/// `*` marking the default; header and state words may be localized, so tokens are read
/// from the right and `running` (names from `wsl -l --running -q`) decides the state,
/// falling back to an English `Running` column.
pub fn parse_distros(list_verbose: &str, running: &HashSet<String>) -> Vec<WslDistro> {
    list_verbose
        .lines()
        .filter_map(|line| {
            let line = line.trim_matches(|c: char| c.is_whitespace() || c == '\0');
            let (is_default, rest) = match line.strip_prefix('*') {
                Some(r) => (true, r.trim_start()),
                None => (false, line),
            };
            let tokens: Vec<&str> = rest.split_whitespace().collect();
            if tokens.len() < 2 {
                return None;
            }
            let version: u8 = tokens.last()?.parse().ok()?;
            let name = tokens[0].to_owned();
            let state = tokens[1..tokens.len() - 1].join(" ");
            let running = running.contains(&name) || state.eq_ignore_ascii_case("running");
            Some(WslDistro { name, is_default, running, version })
        })
        .collect()
}

fn names(text: &str) -> HashSet<String> {
    text.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_owned())
        .filter(|l| !l.is_empty())
        .collect()
}

/// List installed WSL distros (`wsl.exe -l -v`, UTF-16LE aware).
pub async fn list_distros() -> Result<Vec<WslDistro>, TransportError> {
    let wsl = |args: &[&str]| {
        let mut argv = vec!["wsl.exe"];
        argv.extend_from_slice(args);
        Cmd::new(argv).env("WSL_UTF8", "1").timeout(Duration::from_secs(30))
    };
    let out = local::run(&wsl(&["-l", "-v"])).await.map_err(wsl_missing)?;
    let text = decode_wsl(&out.stdout);
    if !out.status.success() {
        let msg = format!("{} {}", text.trim(), decode_wsl(&out.stderr).trim());
        return Err(TransportError::Wsl(msg.trim().to_owned()));
    }
    // Exits non-zero when nothing is running; that just means an empty set.
    let running = match local::run(&wsl(&["-l", "--running", "-q"])).await {
        Ok(o) if o.status.success() => names(&decode_wsl(&o.stdout)),
        _ => HashSet::new(),
    };
    Ok(parse_distros(&text, &running))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(s: &str, bom: bool) -> Vec<u8> {
        let mut v = if bom { vec![0xFF, 0xFE] } else { vec![] };
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        v
    }

    const LIST: &str = "  NAME                   STATE           VERSION\r\n* Ubuntu-24.04           Running         2\r\n  docker-desktop         Stopped         2\r\n  Debian                 Stopped         1\r\n";

    #[test]
    fn decodes_utf16le_and_utf8() {
        assert_eq!(decode_wsl(&utf16le(LIST, false)), LIST);
        assert_eq!(decode_wsl(&utf16le(LIST, true)), LIST);
        assert_eq!(decode_wsl(LIST.as_bytes()), LIST);
    }

    #[test]
    fn parses_list_verbose() {
        let d = parse_distros(&decode_wsl(&utf16le(LIST, false)), &HashSet::new());
        assert_eq!(d.len(), 3);
        assert_eq!(d[0], WslDistro { name: "Ubuntu-24.04".into(), is_default: true, running: true, version: 2 });
        assert_eq!(d[1], WslDistro { name: "docker-desktop".into(), is_default: false, running: false, version: 2 });
        assert_eq!(d[2].version, 1);
    }

    #[test]
    fn parses_localized_list_with_running_set() {
        let de = "  NAME            STATUS           VERSION\r\n* Ubuntu          Wird ausgeführt  2\r\n  Debian          Beendet          2\r\n";
        let running = names(&decode_wsl(&utf16le("Ubuntu\r\n", false)));
        let d = parse_distros(de, &running);
        assert_eq!(d.len(), 2);
        assert!(d[0].running && d[0].is_default);
        assert!(!d[1].running);
    }

    #[test]
    fn builds_wsl_argv() {
        let c = wsl_cmd(Some("Ubuntu"), &Cmd::new(["herdr", "--version"]).cwd("~"));
        assert_eq!(&c.argv[..4], &["wsl.exe", "-d", "Ubuntu", "--exec"]);
        assert_eq!(&c.argv[4..6], &["sh", "-c"]);
        assert_eq!(c.argv.last().unwrap(), "cd ~ && exec herdr --version");
        assert_eq!(c.env, vec![("WSL_UTF8".to_string(), "1".to_string())]);
    }
}
