//! The user's graphical session for forwarded programs (Linux; architecture §3.30). The daemon's
//! own environment may name no session or a gone one: the keepalive timer starts it with HOME,
//! PATH, USER and LANG only, an SSH attach from another device brings none, and a daemon started
//! in an earlier login keeps that login's XAUTHORITY. The systemd user manager knows the current
//! one: desktops put their variables there when they start (GNOME, Plasma, sway's systemd
//! snippet, Xsession's `dbus-update-activation-environment --systemd`).
//!
//! Before a forwarded program starts, hostd reads that environment (`systemctl --user
//! show-environment`; read only, it never sets anything there; at most every [`FRESH_FOR`], one
//! query at a time, given up after [`ASK_TIMEOUT`]). When it names a session (`DISPLAY` or
//! `WAYLAND_DISPLAY` set), the program gets exactly the manager's [`VARS`]: those it has are set,
//! the others removed, so a stale inherited value never wins. Otherwise (a headless server, no
//! user manager, no systemd) the program keeps the daemon's environment.

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tracing::{debug, info};

/// What places a program in a graphical session: its display servers and their cookie, its
/// runtime dir and session bus, and what kind of session it is (toolkits pick their X11 or
/// Wayland backend and portals by these). The rest (input method, scaling, theme) does not decide
/// whether a window opens and stays as the daemon has it.
const VARS: [&str; 9] = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"];

/// How long an answer of the user manager is used.
const FRESH_FOR: Duration = Duration::from_secs(5);
/// How long `systemctl` may take to answer.
const ASK_TIMEOUT: Duration = Duration::from_secs(2);

/// The graphical session a forwarded program gets: each of [`VARS`] with the user manager's
/// value, `None` where the manager has none (removed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Session(Vec<(&'static str, Option<OsString>)>);

impl Session {
    /// The session the user manager's environment (`systemctl show-environment` output) names;
    /// `None` when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set there.
    fn from_manager(out: &[u8]) -> Option<Session> {
        let env = parse(out);
        let get = |name: &str| env.iter().rev().find(|(k, _)| *k == name.as_bytes()).map(|(_, v)| v);
        if !["DISPLAY", "WAYLAND_DISPLAY"].into_iter().any(|k| get(k).is_some_and(|v| !v.is_empty())) {
            return None;
        }
        Some(Session(VARS.into_iter().map(|k| (k, get(k).map(|v| OsString::from_vec(v.clone())))).collect()))
    }

    /// Sets the session's variables on `cmd` and removes the ones it lacks.
    pub(crate) fn apply(&self, cmd: &mut std::process::Command) {
        for (k, v) in &self.0 {
            match v {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            };
        }
    }

    /// `DISPLAY=:0 WAYLAND_DISPLAY=wayland-0`, for the log.
    fn displays(&self) -> String {
        self.0.iter().filter(|(k, _)| k.ends_with("DISPLAY")).filter_map(|(k, v)| Some(format!("{k}={}", v.as_ref()?.to_string_lossy()))).collect::<Vec<_>>().join(" ")
    }
}

/// The last answer and when it came.
static LAST: tokio::sync::Mutex<Option<(Instant, Option<Session>)>> = tokio::sync::Mutex::const_new(None);

/// The user's current graphical session; `None` when the user manager names none (module docs).
pub(crate) async fn current() -> Option<Session> {
    let mut last = LAST.lock().await;
    if let Some((at, session)) = last.as_ref()
        && at.elapsed() < FRESH_FOR
    {
        return session.clone();
    }
    let session = ask().await.as_deref().and_then(Session::from_manager);
    if last.as_ref().is_none_or(|(_, before)| *before != session) {
        match &session {
            Some(s) => info!("forward: programs get the graphical session of the systemd user manager ({})", s.displays()),
            None => info!("forward: the systemd user manager names no graphical session; programs get the daemon's environment"),
        }
    }
    *last = Some((Instant::now(), session.clone()));
    session
}

/// What `systemctl --user show-environment` prints; `None` without systemd or a user manager, or
/// when it fails or takes longer than [`ASK_TIMEOUT`].
async fn ask() -> Option<Vec<u8>> {
    let systemctl = tf_herdr::durable::systemd_tool("systemctl")?;
    let mut cmd = tokio::process::Command::new(systemctl);
    cmd.args(["--user", "show-environment"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // systemctl finds the user manager through XDG_RUNTIME_DIR, which a daemon a system service
    // started lacks.
    if std::env::var_os("XDG_RUNTIME_DIR").is_none_or(|v| v.is_empty()) {
        // SAFETY: geteuid has no preconditions.
        cmd.env("XDG_RUNTIME_DIR", format!("/run/user/{}", unsafe { libc::geteuid() }));
    }
    match tokio::time::timeout(ASK_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => Some(out.stdout),
        Ok(Ok(out)) => {
            debug!("forward: systemctl --user show-environment: {}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim());
            None
        }
        Ok(Err(e)) => {
            debug!("forward: systemctl --user show-environment: {e}");
            None
        }
        Err(_) => {
            debug!("forward: systemctl --user show-environment took longer than {ASK_TIMEOUT:?}");
            None
        }
    }
}

/// The variables of `systemctl show-environment` output: one `NAME=value` line each, the value
/// written the way systemd writes it (as it is when plain, else `$'…'` with C escapes:
/// `shell_maybe_quote` in POSIX mode). Lines that do not parse are skipped.
fn parse(out: &[u8]) -> Vec<(&[u8], Vec<u8>)> {
    out.split(|&b| b == b'\n')
        .filter_map(|line| {
            let eq = line.iter().position(|&b| b == b'=').filter(|&i| i > 0)?;
            Some((&line[..eq], unquote(&line[eq + 1..])?))
        })
        .collect()
}

/// A shell word as systemd writes it, unquoted: bytes as they are, `$'…'` ([`c_escaped`]),
/// `'…'`, `"…"` (a backslash escapes `$`, `` ` ``, `"` and `\`) and a backslash before one byte.
/// `None` when a quote is not closed or the value holds a NUL, which no variable can.
fn unquote(word: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(word.len());
    let mut rest = word;
    while let Some((&b, tail)) = rest.split_first() {
        rest = match b {
            b'$' if tail.first() == Some(&b'\'') => c_escaped(&tail[1..], &mut out)?,
            b'\'' => {
                let end = tail.iter().position(|&c| c == b'\'')?;
                out.extend_from_slice(&tail[..end]);
                &tail[end + 1..]
            }
            b'"' => double_quoted(tail, &mut out)?,
            b'\\' if !tail.is_empty() => {
                out.push(tail[0]);
                &tail[1..]
            }
            _ => {
                out.push(b);
                tail
            }
        };
    }
    (!out.contains(&0)).then_some(out)
}

/// The inside of `$'…'` up to its closing quote, escapes decoded: what systemd writes (`\a \b \f
/// \n \r \t \v \\ \' \"`, octal `\ooo` for other control characters and bytes that are not
/// UTF-8) and `\e`, `\?`, `\xHH`; an unknown escape stays as it is. Returns what follows the quote.
fn c_escaped<'a>(mut s: &'a [u8], out: &mut Vec<u8>) -> Option<&'a [u8]> {
    loop {
        let (&b, tail) = s.split_first()?;
        s = tail;
        match b {
            b'\'' => return Some(s),
            b'\\' => {
                let (&e, tail) = s.split_first()?;
                s = tail;
                match e {
                    b'a' => out.push(0x07),
                    b'b' => out.push(0x08),
                    b'e' | b'E' => out.push(0x1b),
                    b'f' => out.push(0x0c),
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    b'v' => out.push(0x0b),
                    b'\\' | b'\'' | b'"' | b'?' => out.push(e),
                    b'0'..=b'7' => {
                        let n = s.iter().take(2).take_while(|d| (b'0'..=b'7').contains(*d)).count();
                        let value = s[..n].iter().fold(u32::from(e - b'0'), |v, d| v * 8 + u32::from(d - b'0'));
                        out.push(value as u8);
                        s = &s[n..];
                    }
                    b'x' if s.first().is_some_and(u8::is_ascii_hexdigit) => {
                        let n = s.iter().take(2).take_while(|d| d.is_ascii_hexdigit()).count();
                        out.push(s[..n].iter().fold(0u8, |v, d| v * 16 + (*d as char).to_digit(16).unwrap_or(0) as u8));
                        s = &s[n..];
                    }
                    _ => out.extend_from_slice(&[b'\\', e]),
                }
            }
            _ => out.push(b),
        }
    }
}

/// The inside of `"…"` up to its closing quote (a backslash escapes `$`, `` ` ``, `"` and `\`);
/// returns what follows the quote.
fn double_quoted<'a>(mut s: &'a [u8], out: &mut Vec<u8>) -> Option<&'a [u8]> {
    loop {
        let (&b, tail) = s.split_first()?;
        s = tail;
        match b {
            b'"' => return Some(s),
            b'\\' if matches!(s.first(), Some(b'$' | b'`' | b'"' | b'\\')) => {
                out.push(s[0]);
                s = &s[1..];
            }
            _ => out.push(b),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// What `systemctl show-environment` prints: plain values as they are, others as `$'…'`
    /// with escapes (and forms systemd does not write, which still parse).
    const MANAGER: &str = r#"LANG=en_US.UTF-8
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
NAME=zoë
XAUTHORITY=$'/home/zoë/my session/.Xauthority'
LS_COLORS=$'rs=0:di=01;34:*.tar=01;31'
ESCAPED=$'it\'s "quoted" C:\\dir\ttab\nline\033[0m\377\x41\e\q'
EMPTY=
SHELLISH='a b'"c \"d\" \$e"\ f
not a variable
=nameless
OPEN=$'never closed
NUL=$'a\000b'
"#;

    #[test]
    fn reads_values_the_way_systemd_quotes_them() {
        let env = parse(MANAGER.as_bytes());
        let get = |name: &str| env.iter().find(|(k, _)| *k == name.as_bytes()).map(|(_, v)| v.clone());
        assert_eq!(get("DBUS_SESSION_BUS_ADDRESS").as_deref(), Some(&b"unix:path=/run/user/1000/bus"[..]));
        assert_eq!(get("NAME"), Some("zoë".as_bytes().to_vec()));
        assert_eq!(get("XAUTHORITY"), Some("/home/zoë/my session/.Xauthority".as_bytes().to_vec()));
        assert_eq!(get("LS_COLORS").as_deref(), Some(&b"rs=0:di=01;34:*.tar=01;31"[..]));
        assert_eq!(get("ESCAPED").as_deref(), Some(&b"it's \"quoted\" C:\\dir\ttab\nline\x1b[0m\xffA\x1b\\q"[..]));
        assert_eq!(get("EMPTY").as_deref(), Some(&b""[..]));
        assert_eq!(get("SHELLISH").as_deref(), Some(&b"a bc \"d\" $e f"[..]));
        let names: Vec<_> = env.iter().map(|(k, _)| String::from_utf8_lossy(k).into_owned()).collect();
        assert_eq!(names, ["LANG", "DBUS_SESSION_BUS_ADDRESS", "NAME", "XAUTHORITY", "LS_COLORS", "ESCAPED", "EMPTY", "SHELLISH"], "lines that do not parse are skipped");
    }

    /// A session the user manager names reaches the program exactly, whatever the daemon
    /// inherited: what the manager has is set, what it lacks is removed, the rest stays.
    #[test]
    fn a_named_session_replaces_what_the_daemon_inherited() {
        let manager = b"PATH=/manager/bin\nDISPLAY=:1\nXAUTHORITY=$'/run/user/1000/x auth'\nXDG_RUNTIME_DIR=/run/user/1000\nXDG_SESSION_TYPE=x11\n";
        let session = Session::from_manager(manager).expect("a session");
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", r#"printf '%s|' "${DISPLAY-unset}" "${XAUTHORITY-unset}" "${WAYLAND_DISPLAY-unset}" "${XDG_SESSION_TYPE-unset}" "${DBUS_SESSION_BUS_ADDRESS-unset}" "$PATH""#]);
        // What a daemon started in an earlier login carries.
        cmd.env("DISPLAY", ":0").env("XAUTHORITY", "/run/user/1000/.mutter-Xwaylandauth.OLD").env("WAYLAND_DISPLAY", "wayland-0").env("DBUS_SESSION_BUS_ADDRESS", "unix:abstract=/tmp/dbus-OLD").env("PATH", "/usr/bin:/bin");
        session.apply(&mut cmd);
        let out = cmd.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), ":1|/run/user/1000/x auth|unset|x11|unset|/usr/bin:/bin|");
    }

    /// No graphical session there (a headless server's manager, or `DISPLAY` and
    /// `WAYLAND_DISPLAY` empty): the program keeps the daemon's environment. A Wayland session
    /// without X still is one: its empty `DISPLAY` is passed on as it is.
    #[test]
    fn only_a_display_makes_a_session() {
        for out in ["", "PATH=/usr/bin\nXDG_RUNTIME_DIR=/run/user/0\nDBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus\n", "DISPLAY=\nWAYLAND_DISPLAY=\n"] {
            assert_eq!(Session::from_manager(out.as_bytes()), None, "{out:?}");
        }
        let session = Session::from_manager(b"WAYLAND_DISPLAY=wayland-1\nDISPLAY=\nXDG_CURRENT_DESKTOP=sway\n").expect("a session");
        let mut cmd = std::process::Command::new("true");
        session.apply(&mut cmd);
        let envs: BTreeMap<_, _> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        let expect = |k: &str, v: Option<&str>| (k.to_string(), v.map(str::to_string));
        assert_eq!(
            envs,
            BTreeMap::from([
                expect("DBUS_SESSION_BUS_ADDRESS", None),
                expect("DESKTOP_SESSION", None),
                expect("DISPLAY", Some("")),
                expect("WAYLAND_DISPLAY", Some("wayland-1")),
                expect("XAUTHORITY", None),
                expect("XDG_CURRENT_DESKTOP", Some("sway")),
                expect("XDG_RUNTIME_DIR", None),
                expect("XDG_SESSION_DESKTOP", None),
                expect("XDG_SESSION_TYPE", None),
            ])
        );
    }
}
