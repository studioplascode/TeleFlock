//! WSL transport: commands run as `wsl.exe -d <distro> --exec sh -c <bootstrap> sh <base64>`
//! through the local process layer ([`quote::bootstrap_argv`]). `--exec` avoids an extra
//! Linux-side shell layer; the bootstrap runs the command in the user's login shell (same as SSH),
//! which puts `~/.local/bin` on PATH. Every argument is plain ([`quote::is_plain`]): wsl.exe gets
//! one Windows command line, which its builds may split differently once quotes or backslashes
//! are involved. The distro warm-up and [`WslKeepalive`] need no login shell and run their
//! program directly. Previews use plain localhost (WSL2 forwards it).

use std::collections::HashSet;
use std::process::Stdio;
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

/// wsl.exe running `words` in the distro directly (`--exec`: no shell on either side). Every
/// word must be [`quote::is_plain`].
fn wsl_direct(distro: Option<&str>, words: impl IntoIterator<Item = String>) -> Cmd {
    let mut argv: Vec<String> = vec!["wsl.exe".into()];
    if let Some(d) = distro {
        argv.push("-d".into());
        argv.push(d.into());
    }
    argv.push("--exec".into());
    argv.extend(words);
    debug_assert!(argv.iter().all(|w| quote::is_plain(w)), "{argv:?}");
    Cmd { argv, env: vec![("WSL_UTF8".into(), "1".into())], ..Cmd::default() }
}

/// wsl.exe argv for `cmd`, run in the user's login shell.
fn wsl_cmd(distro: Option<&str>, cmd: &Cmd) -> Cmd {
    Cmd { stdin: cmd.stdin.clone(), timeout: cmd.timeout, ..wsl_direct(distro, quote::bootstrap_argv(cmd)) }
}

/// wsl.exe reads the `-d` value up to the first blank and does not honour quotes there: a name it
/// would read back differently can't be selected with `-d` at all, so it is a configuration error.
fn check_distro(distro: Option<&str>) -> Result<(), TransportError> {
    match distro {
        Some(d) if !quote::is_plain(d) || d.contains(' ') => {
            Err(TransportError::Config(format!("WSL distro name {d:?} can't be passed to wsl.exe; pick the distro from `wsl -l -v`")))
        }
        _ => Ok(()),
    }
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
    /// Warm the distro up (boots the VM if needed) and verify it exists: `wsl.exe --exec true`,
    /// without the login shell, whose profile files can take seconds on a slow machine.
    pub async fn connect(
        distro: Option<String>,
        opts: &ConnectOptions,
        events: mpsc::Sender<TransportEvent>,
    ) -> Result<Arc<Self>, TransportError> {
        check_distro(distro.as_deref())?;
        let label = distro.clone().unwrap_or_else(|| "default distro".into());
        let _ = events.send(TransportEvent::Phase(ConnPhase::Connecting, Some(format!("Starting WSL ({label})…")))).await;
        let warm = Cmd { timeout: Some(opts.wsl_start_timeout), ..wsl_direct(distro.as_deref(), ["true".to_string()]) };
        let out = local::run(&warm).await.map(fix_stderr).map_err(wsl_missing)?;
        if !out.status.success() {
            let msg = format!("{}{}", decode_wsl(&out.stdout), out.stderr_str());
            return Err(TransportError::Wsl(format!("{label}: {}", msg.trim())));
        }
        Ok(Arc::new(Self { local: LocalTransport::with_kind(HostKind::Wsl, events), distro }))
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
    // Each is a wsl.exe start: run both at once.
    let (list, live) = (wsl(&["-l", "-v"]), wsl(&["-l", "--running", "-q"]));
    let (verbose, running) = tokio::join!(local::run(&list), local::run(&live));
    let out = verbose.map_err(wsl_missing)?;
    let text = decode_wsl(&out.stdout);
    if !out.status.success() {
        let msg = format!("{} {}", text.trim(), decode_wsl(&out.stderr).trim());
        return Err(TransportError::Wsl(msg.trim().to_owned()));
    }
    // Exits non-zero when nothing is running; that just means an empty set.
    let running = match running {
        Ok(o) if o.status.success() => names(&decode_wsl(&o.stdout)),
        _ => HashSet::new(),
    };
    Ok(parse_distros(&text, &running))
}

/// [`WslKeepalive`]'s program, run directly (no shell, so no login profile either). 68 years
/// rather than `sleep infinity`, which old busybox lacks: every `sleep` takes this number, so
/// there is nothing to fall back from.
const KEEPALIVE: [&str; 2] = ["sleep", "2147483647"];

/// Keeps a WSL distro running while it lives. WSL stops a distro `instanceIdleTimeout` (default
/// 15 s) after its last `wsl.exe` client exits, and tf-hostd, herdr and every agent in it stop
/// with it; the app's other clients (`attach`, one-shot commands) all end with a reconnect.
/// Dropping it kills its `wsl.exe` and releases the distro.
pub struct WslKeepalive {
    child: tokio::process::Child,
}

impl WslKeepalive {
    /// Starts `wsl.exe [-d <distro>] --exec sleep 2147483647` (`None`: the default distro). Must
    /// run inside a tokio runtime.
    pub fn start(distro: Option<&str>) -> Result<Self, TransportError> {
        check_distro(distro)?;
        let mut c = local::command(&wsl_direct(distro, KEEPALIVE.map(String::from)));
        c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let child = c.spawn().map_err(|e| wsl_missing(local::spawn_err("wsl.exe", e)))?;
        Ok(Self { child })
    }

    /// Still holding the distro: `false` once `wsl.exe` ended (the distro was terminated, WSL was
    /// shut down, or there is no such distro).
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;

    /// The upload from the report (tf-client `deploy::upload_script` for `bin/tf-hostd`), which
    /// failed on every attempt with `sha256sum: 4: Syntax error: Unterminated quoted string`.
    const REPORTED: &str = r#"set -e
umask 077
H=/home/user/.teleflock
sum() { if command -v sha256sum >/dev/null 2>&1; then a=$(sha256sum "$1"); elif command -v shasum >/dev/null 2>&1; then a=$(shasum -a 256 "$1"); else echo 'neither sha256sum nor shasum is installed on the host' >&2; exit 3; fi; a=${a%% *}; }
mkdir -p "$H/bin"
t0="$H/bin/tf-hostd.tmp.$$"
trap 'rm -f "$t0"' EXIT
cat > "$t0"
sum "$t0"
if [ "$a" != 21b98aa2f4f2a10a3d747eeeaeaad2db9483315ca57986623a0b683a6d7f6878 ]; then echo "checksum mismatch for bin/tf-hostd: got $a, expected "21b98aa2f4f2a10a3d747eeeaeaad2db9483315ca57986623a0b683a6d7f6878 >&2; exit 4; fi
chmod 755 "$t0"
v=$("$t0" --version 2>/dev/null | head -n 1) || true
echo "tf.version=$v"
if [ "$v" != 'tf-hostd 0.6.1 proto 1' ]; then echo "the uploaded bin/tf-hostd reports '$v', expected "'tf-hostd 0.6.1 proto 1' >&2; exit 5; fi
mv -f "$t0" "$H/bin/tf-hostd"
printf '%s' 21b98aa2f4f2a10a3d747eeeaeaad2db9483315ca57986623a0b683a6d7f6878 > "$H/bin/tf-hostd.sha256"
"#;

    fn random_cmd(rng: &mut Rng) -> Cmd {
        let n = 1 + rng.below(5);
        let mut cmd = Cmd::new((0..n).map(|_| rng.word()));
        cmd.env = (0..rng.below(3)).map(|i| (format!("K{i}"), rng.word())).collect();
        cmd.cwd = (rng.below(2) == 0).then(|| rng.word());
        cmd
    }

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
        let cmd = Cmd::new(["herdr", "--version"]).cwd("~").stdin(b"x".to_vec()).timeout(Duration::from_secs(3));
        let c = wsl_cmd(Some("Ubuntu"), &cmd);
        assert_eq!(&c.argv[..4], &["wsl.exe", "-d", "Ubuntu", "--exec"]);
        assert_eq!(c.argv[4..], quote::bootstrap_argv(&cmd));
        assert_eq!((&c.stdin, c.timeout), (&cmd.stdin, cmd.timeout));
        assert_eq!(c.env, vec![("WSL_UTF8".to_string(), "1".to_string())]);
        // The warm-up and the keepalive run their program themselves: no shell, no login profile.
        assert_eq!(wsl_direct(None, ["true".to_string()]).argv, ["wsl.exe", "--exec", "true"]);
        assert_eq!(wsl_direct(Some("Debian"), KEEPALIVE.map(String::from)).argv, ["wsl.exe", "-d", "Debian", "--exec", "sleep", "2147483647"]);
    }

    #[test]
    fn distro_names_must_survive_the_command_line() {
        assert!(check_distro(None).is_ok() && check_distro(Some("Ubuntu-24.04")).is_ok());
        for bad in ["", "My Distro", "a\"b", r"a\b", "a'b", "a\tb"] {
            let e = check_distro(Some(bad)).unwrap_err();
            assert!(matches!(e, TransportError::Config(_)) && !e.retryable(), "{bad:?}: {e:?}");
        }
    }

    /// The reported upload and random commands (quotes, backslashes, newlines, tabs, unicode):
    /// Linux gets exactly the words after `--exec`, whichever rule set wsl.exe splits its command
    /// line with.
    #[test]
    fn wsl_command_lines_split_the_same_under_every_rule_set() {
        let mut rng = Rng::new(3);
        let mut cmds = vec![Cmd::new(["sh", "-c", REPORTED])];
        cmds.extend((0..2000).map(|_| random_cmd(&mut rng)));
        for cmd in &cmds {
            let argv = wsl_cmd(Some("Ubuntu"), cmd).argv;
            let line = rust_command_line(&argv);
            let rest = after_exec(&line).expect("wsl.exe reads up to --exec");
            for rules in Rules::ALL {
                assert_eq!(rules.split(rest), argv[4..], "{rules:?}: {line}");
            }
        }
    }

    /// The check has teeth: the words wsl.exe used to get (the command POSIX-quoted inside one
    /// argument) come out right only under `CommandLineToArgvW`.
    #[test]
    fn rule_sets_disagree_once_quotes_or_backslashes_are_involved() {
        let old = ["wsl.exe", "-d", "Ubuntu", "--exec", "sh", "-c", r#"exec "${SHELL:-/bin/sh}" -lc "$1""#, "sh", r"exec sh -c 'echo '\''a\b'\'''"].map(String::from);
        let line = rust_command_line(&old);
        let rest = after_exec(&line).unwrap();
        assert_eq!(Rules::CommandLineToArgvW.split(rest), old[4..]);
        let differ: Vec<Rules> = Rules::ALL.into_iter().filter(|r| r.split(rest) != old[4..]).collect();
        assert_eq!(differ.len(), 3, "{differ:?}");
    }

    /// On the Linux side: whatever each rule set hands Linux runs the program with exactly the
    /// argv it was given, in every login shell (`TF_TEST_LOGIN_SHELLS` adds real ones).
    #[cfg(unix)]
    #[test]
    fn wsl_commands_reach_the_program_exactly() {
        let dir = TempDir::new("wsl-exact");
        let home = dir.0.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut rng = Rng::new(4);
        for shell in login_shells(&dir.0) {
            for _ in 0..10 {
                let args: Vec<String> = (0..1 + rng.below(4)).map(|_| rng.word()).collect();
                let mut cmd = Cmd::new(["printf", "%s\\0"]);
                cmd.argv.extend(args.iter().cloned());
                let line = rust_command_line(&wsl_cmd(Some("Ubuntu"), &cmd).argv);
                for rules in Rules::ALL {
                    let out = run_on_host(&rules.split(after_exec(&line).unwrap()), &shell, &home, b"");
                    assert_eq!(fields(&out.stdout), args, "{rules:?} {}: {}", shell.display(), String::from_utf8_lossy(&out.stderr));
                }
            }
        }
        assert_eq!(strict_calls(&dir.0), 10 * Rules::ALL.len(), "the strict login shell ran each case");
    }

    #[test]
    fn wsl_start_failures_retry_unless_wsl_or_the_distro_is_missing() {
        let timeout = "Ubuntu: The operation timed out because a response was not received from the virtual machine or container. Error code: Wsl/Service/CreateInstance/HCS_E_CONNECTION_TIMEOUT";
        assert!(TransportError::Wsl(timeout.into()).retryable());
        let missing = "Ubuntu: There is no distribution with the supplied name. Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND";
        assert!(!TransportError::Wsl(missing.into()).retryable());
        let no_wsl = wsl_missing(TransportError::Spawn { program: "wsl.exe".into(), detail: "No such file or directory".into() });
        assert!(!no_wsl.retryable());
    }
}
