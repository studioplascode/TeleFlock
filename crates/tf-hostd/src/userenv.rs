//! The user's environment for everything tf-hostd starts (architecture §3.2).
//!
//! The daemon starts from a login shell (`attach` over SSH or WSL), from the automations
//! keepalive timer (`ensure`) or by hand, and none of them has the PATH the user's terminals
//! have: Ubuntu's `~/.bashrc` returns early unless the shell is interactive, and that is where
//! bun's and nvm's installers put `~/.bun/bin` and node. omp installed with bun is a
//! `#!/usr/bin/env bun` script, so without it `omp update`, `omp config` and `omp --version` fail
//! with "/usr/bin/env: 'bun': No such file or directory".
//!
//! [`prepare`] runs once at daemon start, before any other thread exists (changing the
//! environment is only sound then), and sets PATH for the whole process, so every child inherits
//! it: omp and its interpreter, the herdr server and its panes, git, gh, installers. PATH becomes,
//! absolute entries only, each once (its first position wins):
//! 1. the PATH of the user's interactive login shell (`$SHELL -i -l -c`, else the passwd shell;
//!    stdin `/dev/null`, its own session, stderr dropped, killed after [`SHELL_TIMEOUT`]);
//! 2. entries only the inherited PATH has;
//! 3. the well-known install dirs ([`well_known_dirs`]) that exist, `~/.local/bin` and
//!    `~/.bun/bin` always (TeleFlock's installers put omp, herdr, gh and bun there).
//!
//! When step 1 fails (no usable shell, timeout, no PATH printed) the rest still applies; the log
//! says why. Windows: the inherited PATH stays as it is.
#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tracing::{debug, info};

use crate::ops::git::is_executable;

/// How long the interactive login shell may take to print its PATH.
pub const SHELL_TIMEOUT: Duration = Duration::from_secs(6);

/// Per-user install dirs (relative to home) in search order. The first [`ALWAYS_ON_PATH`] join
/// PATH even before they exist: TeleFlock's own installers create them.
const USER_DIRS: &[&str] = &[
    ".local/bin",
    ".bun/bin",
    ".cargo/bin",
    ".npm-global/bin",
    "bin",
    ".deno/bin",
    ".volta/bin",
    ".local/share/mise/shims",
    ".asdf/shims",
    ".linuxbrew/bin",
];
const ALWAYS_ON_PATH: usize = 2;
/// System dirs a minimal PATH may lack (Homebrew, Linuxbrew, the usual bins).
const SYSTEM_DIRS: &[&str] = &["/usr/local/bin", "/opt/homebrew/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/bin", "/bin"];
/// More stdout than this from the probe shell is not a PATH.
const MAX_SHELL_OUTPUT: usize = 1 << 20;

/// The well-known install dirs, in search order (unix layout): `~/.local/bin`, `~/.bun/bin`,
/// `~/.cargo/bin`, `~/.npm-global/bin`, `~/bin`, `~/.deno/bin`, `~/.volta/bin`, mise and asdf
/// shims, Linuxbrew, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `/bin`.
pub fn well_known_dirs(home: &Path) -> Vec<PathBuf> {
    USER_DIRS.iter().map(|d| home.join(d)).chain(SYSTEM_DIRS.iter().map(PathBuf::from)).collect()
}

/// PATH from its parts (module docs): `interactive`, then entries only `inherited` has, then
/// `extra`. Absolute entries only, each once (its first position wins).
pub fn merge_path(interactive: &[PathBuf], inherited: &[PathBuf], extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::with_capacity(interactive.len() + inherited.len() + extra.len());
    for dir in interactive.iter().chain(inherited).chain(extra) {
        if dir.is_absolute() && !has_separator(dir) && !out.contains(dir) {
            out.push(dir.clone());
        }
    }
    out
}

fn has_separator(dir: &Path) -> bool {
    let sep = if cfg!(windows) { ';' } else { ':' };
    dir.as_os_str().to_string_lossy().contains(sep)
}

/// The POSIX script a probe runs (`$TF_EXEC`) and the markers around the PATH it prints. Each
/// marker is printed from two words, so an echo of the command line never contains it.
fn probe(nonce: &str) -> (String, String, String) {
    let begin = format!("__TF_PATH_BEGIN_{nonce}__");
    let end = format!("__TF_PATH_END_{nonce}__");
    let script = format!("printf '%s' '__TF_PATH_' 'BEGIN_{nonce}__' \"$PATH\" '__TF_PATH_' 'END_{nonce}__'");
    (begin, end, script)
}

/// What the probe shell runs: hand `$TF_EXEC` to POSIX `sh` (the line tf-transport's
/// `quote::LOGIN_COMMAND` gives every login shell). sh, bash, zsh, ksh, fish, nushell and csh all
/// read it the same way; the printf itself (`"$PATH"`) is POSIX, which nushell can't parse.
#[cfg(unix)]
const PROBE_COMMAND: &str = r#"exec sh -c 'eval "$TF_EXEC"'"#;

/// An interactive login shell's flags before the command. csh and tcsh take `-l` only on its
/// own, so they run interactive without it (their rc files set PATH).
#[cfg(unix)]
fn probe_flags(shell: &Path) -> &'static [&'static str] {
    match shell.file_name().and_then(|n| n.to_str()) {
        Some("csh" | "tcsh") => &["-i", "-c"],
        _ => &["-i", "-l", "-c"],
    }
}

/// The text between the first `begin` and the next `end` in `out` (a shell's stdout, rc-file
/// noise included).
pub fn between<'a>(out: &'a [u8], begin: &[u8], end: &[u8]) -> Option<&'a [u8]> {
    let start = find(out, begin)? + begin.len();
    let len = find(&out[start..], end)?;
    Some(&out[start..start + len])
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// A printed PATH, when it looks like one: one line with at least one absolute entry.
fn printed_path(raw: &[u8]) -> Result<OsString, String> {
    if raw.contains(&b'\n') || raw.contains(&0) {
        return Err("printed a PATH with a line break".into());
    }
    let text = String::from_utf8_lossy(raw);
    if !text.split(':').any(|d| d.starts_with('/')) {
        return Err("printed an empty PATH".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Ok(OsString::from_vec(raw.to_vec()))
    }
    #[cfg(not(unix))]
    {
        Ok(OsString::from(text.into_owned()))
    }
}

/// The user's login shell: `$SHELL`, else the passwd entry; `None` when neither is usable.
#[cfg(unix)]
pub fn login_shell() -> Option<PathBuf> {
    let usable = |s: &PathBuf| {
        s.is_absolute() && !matches!(s.file_name().and_then(|n| n.to_str()), Some("nologin" | "false" | "true")) && is_executable(s)
    };
    std::env::var_os("SHELL").filter(|s| !s.is_empty()).map(PathBuf::from).filter(usable).or_else(|| passwd_shell().filter(usable))
}

/// The passwd shell of the current user.
#[cfg(unix)]
fn passwd_shell() -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: a zeroed passwd is a valid out-parameter; getpwuid_r writes into it and `buf` only.
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: getuid has no preconditions; every pointer is valid for the duration of the call
    // and `buf.len()` is its size.
    let rc = unsafe { libc::getpwuid_r(libc::getuid(), &mut pw, buf.as_mut_ptr(), buf.len(), &mut out) };
    if rc != 0 || out.is_null() || pw.pw_shell.is_null() {
        return None;
    }
    // SAFETY: on success pw_shell points to a NUL-terminated string inside `buf`.
    let shell = unsafe { std::ffi::CStr::from_ptr(pw.pw_shell) };
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(shell.to_bytes())))
}

/// The PATH `shell` has as an interactive login shell: `shell -i -l -c PROBE_COMMAND` in `home`,
/// stdin `/dev/null`, stderr dropped, in a session of its own (no controlling terminal to take
/// over). Stops reading once the PATH is printed; then whatever is left of that session is
/// killed, also after `timeout`.
#[cfg(unix)]
pub fn interactive_path(shell: &Path, home: &Path, timeout: Duration) -> Result<OsString, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;

    let nonce = format!(
        "{:x}{:x}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0)
    );
    let (begin, end, script) = probe(&nonce);
    let mut cmd = std::process::Command::new(shell);
    cmd.args(probe_flags(shell))
        .arg(PROBE_COMMAND)
        .env("TF_EXEC", &script)
        .current_dir(home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    // SAFETY: setsid is async-signal-safe; called between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let Some(mut stdout) = child.stdout.take() else { return Err("no stdout".into()) };
    let deadline = Instant::now() + timeout;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let result = loop {
        if let Some(raw) = between(&buf, begin.as_bytes(), end.as_bytes()) {
            break printed_path(raw);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break Err(format!("no PATH within {} s", timeout.as_secs()));
        }
        let mut pfd = libc::pollfd { fd: stdout.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd for the duration of the call.
        let ready = unsafe { libc::poll(&mut pfd, 1, left.as_millis().clamp(1, i32::MAX as u128) as i32) };
        if ready < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break Err(format!("poll: {e}"));
        }
        if ready == 0 {
            continue;
        }
        // Readable or hung up: this read does not block.
        match stdout.read(&mut chunk) {
            Ok(0) => break Err("exited without printing its PATH".into()),
            Ok(n) if buf.len() + n > MAX_SHELL_OUTPUT => break Err("too much output".into()),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => break Err(e.to_string()),
        }
    };
    drop(stdout);
    // The shell leads its own session and is not reaped yet, so its group id is still ours: this
    // ends it and anything its rc files left running in the group.
    if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: plain syscall.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
    let _ = child.wait();
    result
}

/// What [`prepare`] did; [`Prepared::log`] writes it once logging is up.
#[derive(Debug)]
pub struct Prepared {
    /// Where the leading PATH entries came from (`/bin/bash -i -l`), or why the inherited PATH
    /// leads.
    pub source: String,
    pub entries: usize,
    pub bytes: usize,
    /// Entries the inherited PATH lacked.
    pub added: usize,
    pub took: Duration,
}

impl Prepared {
    pub fn log(&self) {
        info!(source = %self.source, entries = self.entries, bytes = self.bytes, added = self.added, ms = self.took.as_millis() as u64, "user PATH");
        debug!(path = ?std::env::var_os("PATH"), "user PATH entries");
    }
}

/// Sets PATH for this process and every child it starts (module docs). Call it while this is the
/// only thread (`daemon::run`, before the logger and the runtime).
pub fn prepare() -> Prepared {
    let started = Instant::now();
    let inherited_raw = std::env::var_os("PATH").unwrap_or_default();
    let inherited: Vec<PathBuf> = std::env::split_paths(&inherited_raw).collect();
    #[cfg(unix)]
    {
        let home = crate::paths::home_dir();
        let (interactive, source): (Vec<PathBuf>, String) = match login_shell() {
            None => (Vec::new(), "inherited PATH (no usable login shell)".into()),
            Some(shell) => match interactive_path(&shell, &home, SHELL_TIMEOUT) {
                Ok(path) => (std::env::split_paths(&path).collect(), format!("{} -i -l", shell.display())),
                Err(e) => (Vec::new(), format!("inherited PATH ({} -i -l: {e})", shell.display())),
            },
        };
        let extra: Vec<PathBuf> =
            well_known_dirs(&home).into_iter().enumerate().filter(|(i, d)| *i < ALWAYS_ON_PATH || d.is_dir()).map(|(_, d)| d).collect();
        let merged = merge_path(&interactive, &inherited, &extra);
        let added = merged.iter().filter(|d| !inherited.contains(d)).count();
        match std::env::join_paths(&merged) {
            Ok(path) => {
                let bytes = path.len();
                // SAFETY: `daemon::run` calls this before the logger, the runtime or any other
                // thread exists, so nothing reads the environment concurrently.
                unsafe { std::env::set_var("PATH", &path) };
                Prepared { source, entries: merged.len(), bytes, added, took: started.elapsed() }
            }
            Err(e) => Prepared {
                source: format!("inherited PATH (join: {e})"),
                entries: inherited.len(),
                bytes: inherited_raw.len(),
                added: 0,
                took: started.elapsed(),
            },
        }
    }
    #[cfg(not(unix))]
    {
        Prepared { source: "inherited PATH".into(), entries: inherited.len(), bytes: inherited_raw.len(), added: 0, took: started.elapsed() }
    }
}

// ───────────────────────────── scripts ─────────────────────────────

/// What a script's `#!` line runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Interpreter {
    /// `#!/usr/bin/env bun` (`env` options and `VAR=value` words skipped): looked up on PATH.
    Env(String),
    /// `#!/usr/bin/node`.
    Path(PathBuf),
}

impl Interpreter {
    /// `bun`, `node`, …
    pub fn name(&self) -> String {
        match self {
            Interpreter::Env(name) => name.clone(),
            Interpreter::Path(p) => p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string()),
        }
    }

    /// The `#!` line as written, for messages.
    pub fn line(&self) -> String {
        match self {
            Interpreter::Env(name) => format!("#!/usr/bin/env {name}"),
            Interpreter::Path(p) => format!("#!{}", p.display()),
        }
    }
}

/// The interpreter the `#!` line at the start of `head` names; `None` for binaries and scripts
/// without one.
pub fn shebang(head: &[u8]) -> Option<Interpreter> {
    let rest = head.strip_prefix(b"#!")?;
    let line = rest.split(|b| *b == b'\n').next()?;
    let line = std::str::from_utf8(line).ok()?.trim_end_matches('\r');
    let mut words = line.split_whitespace();
    let program = words.next()?;
    if Path::new(program).file_name().is_some_and(|n| n == "env") {
        let name = words.find(|w| !w.starts_with('-') && !w.contains('='))?;
        return Some(Interpreter::Env(name.to_string()));
    }
    Some(Interpreter::Path(PathBuf::from(program)))
}

/// The interpreter `bin` needs and cannot find: a script whose `env` lookup misses PATH, or whose
/// interpreter path is gone. `None` when it can start (binaries, scripts with their interpreter).
pub fn missing_interpreter(bin: &Path) -> Option<Interpreter> {
    let mut head = [0u8; 256];
    let n = std::fs::File::open(bin).and_then(|mut f| f.read(&mut head)).ok()?;
    let interpreter = shebang(&head[..n])?;
    let found = match &interpreter {
        Interpreter::Env(name) => on_path(name).is_some(),
        Interpreter::Path(p) => is_executable(p),
    };
    (!found).then_some(interpreter)
}

/// `name` in a PATH dir: what `env` and `execvp` run.
pub fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| is_executable(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn merge_orders_dedupes_and_drops_relative_entries() {
        let interactive = paths(&["/home/u/.bun/bin", "/home/u/.nvm/versions/node/v22/bin", "/usr/bin", "/bin"]);
        let inherited = paths(&["/usr/local/bin", "/usr/bin/", "", ".", "bin", "/opt/tool/bin", "/usr/local/bin"]);
        let extra = paths(&["/home/u/.local/bin", "/home/u/.bun/bin", "/opt/tool/bin", "/home/u/we:ird"]);
        assert_eq!(
            merge_path(&interactive, &inherited, &extra),
            paths(&[
                "/home/u/.bun/bin",
                "/home/u/.nvm/versions/node/v22/bin",
                "/usr/bin",
                "/bin",
                "/usr/local/bin",
                "/opt/tool/bin",
                "/home/u/.local/bin",
            ]),
            "interactive first, then what only the inherited PATH has, then well-known dirs; once each"
        );
        assert_eq!(merge_path(&[], &paths(&["/usr/bin", "/bin"]), &paths(&["/root/.local/bin"])), paths(&["/usr/bin", "/bin", "/root/.local/bin"]));
    }

    #[test]
    fn well_known_dirs_lead_with_the_install_targets() {
        let dirs = well_known_dirs(Path::new("/home/u"));
        assert_eq!(dirs[..ALWAYS_ON_PATH], paths(&["/home/u/.local/bin", "/home/u/.bun/bin"]));
        for d in ["/home/u/.deno/bin", "/home/u/.volta/bin", "/home/u/.local/share/mise/shims", "/home/u/.asdf/shims", "/opt/homebrew/bin", "/home/linuxbrew/.linuxbrew/bin"] {
            assert!(dirs.contains(&PathBuf::from(d)), "{d}");
        }
    }

    #[test]
    fn markers_survive_noisy_shells() {
        let (begin, end, script) = probe("abc");
        assert!(!script.contains(&begin) && !script.contains(&end), "an echoed command line never matches");
        let noisy = format!("Welcome to Ubuntu\n\u{1b}]0;user@host\u{7}{begin}/home/u/.bun/bin:/usr/bin{end}\nlogout\n");
        let raw = between(noisy.as_bytes(), begin.as_bytes(), end.as_bytes()).unwrap();
        assert_eq!(printed_path(raw).unwrap(), OsString::from("/home/u/.bun/bin:/usr/bin"));
        let echoed = format!("{script}\n{begin}/usr/bin{end}");
        assert_eq!(between(echoed.as_bytes(), begin.as_bytes(), end.as_bytes()), Some(&b"/usr/bin"[..]));
        assert_eq!(between(format!("{begin}/usr/bin").as_bytes(), begin.as_bytes(), end.as_bytes()), None, "cut off");
        assert_eq!(between(format!("{end}{begin}").as_bytes(), begin.as_bytes(), end.as_bytes()), None);
        assert!(printed_path(b"").is_err());
        assert!(printed_path(b"/usr/bin\n/bin").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn interactive_path_reads_between_markers_and_times_out() {
        use crate::test_exe::write_exe;
        let td = tempfile::tempdir().unwrap();
        // A "shell" that prints noise around the PATH it was given, then lingers.
        let shell = td.path().join("noisy-sh");
        write_exe(&shell, "#!/bin/sh\necho 'motd: hello'\nshift 3\nPATH=/opt/x/bin:/usr/bin\neval \"$1\"\necho tail\nexec sleep 30\n");
        let started = Instant::now();
        assert_eq!(interactive_path(&shell, td.path(), Duration::from_secs(5)).unwrap(), OsString::from("/opt/x/bin:/usr/bin"));
        assert!(started.elapsed() < Duration::from_secs(4), "stops at the end marker, kills the rest");

        let hung = td.path().join("hung-sh");
        write_exe(&hung, "#!/bin/sh\necho 'starting…'\nexec sleep 30\n");
        let started = Instant::now();
        let err = interactive_path(&hung, td.path(), Duration::from_millis(400)).unwrap_err();
        assert!(err.contains("no PATH within"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(3));

        let silent = td.path().join("silent-sh");
        write_exe(&silent, "#!/bin/sh\nexit 0\n");
        assert!(interactive_path(&silent, td.path(), Duration::from_secs(2)).unwrap_err().contains("without printing"));
    }

    /// Whatever the user's shell parses, the probe only needs it to run `PROBE_COMMAND`: a `nu`
    /// that refuses any other line, and a `tcsh` that refuses `-l` with a command (as tcsh does),
    /// both report the PATH their rc files set.
    #[cfg(unix)]
    #[test]
    fn interactive_path_asks_any_shell_only_for_the_probe_command() {
        use crate::test_exe::write_exe;
        let td = tempfile::tempdir().unwrap();
        let line = format!("'{}'", PROBE_COMMAND.replace('\'', r"'\''"));
        for (name, flags, cmd_arg) in [("nu", "-i -l -c", "$4"), ("tcsh", "-i -c", "$3")] {
            let dir = td.path().join(format!("{name}-home"));
            std::fs::create_dir_all(&dir).unwrap();
            let shell = dir.join(name);
            let n = flags.split(' ').count();
            let args = (1..=n).map(|i| format!("${i}")).collect::<Vec<_>>().join(" ");
            let script = format!(
                "#!/bin/sh\nif [ \"{args}\" != \"{flags}\" ] || [ \"{cmd_arg}\" != {line} ]; then echo \"refused: $*\" >&2; exit 2; fi\nPATH=/opt/{name}/bin:/usr/bin:/bin\nexec sh -c \"{cmd_arg}\"\n"
            );
            write_exe(&shell, script);
            let path = interactive_path(&shell, &dir, Duration::from_secs(5)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(path, OsString::from(format!("/opt/{name}/bin:/usr/bin:/bin")), "{name}");
        }
    }

    #[test]
    fn shebangs() {
        assert_eq!(shebang(b"#!/usr/bin/env bun\nconsole.log(1)"), Some(Interpreter::Env("bun".into())));
        assert_eq!(shebang(b"#!/usr/bin/env -S node --no-warnings\r\n"), Some(Interpreter::Env("node".into())));
        assert_eq!(shebang(b"#! /usr/bin/env NODE_OPTIONS=x node\n"), Some(Interpreter::Env("node".into())));
        assert_eq!(shebang(b"#!/home/u/.bun/bin/bun\n"), Some(Interpreter::Path("/home/u/.bun/bin/bun".into())));
        assert_eq!(shebang(b"\x7fELF\x02\x01\x01"), None, "binaries have none");
        assert_eq!(shebang(b"// plain script"), None);
        assert_eq!(shebang(b"#!/usr/bin/env\n"), None);
        assert_eq!(Interpreter::Path("/usr/bin/node".into()).name(), "node");
        assert_eq!(Interpreter::Env("bun".into()).line(), "#!/usr/bin/env bun");
    }

    #[cfg(unix)]
    #[test]
    fn missing_interpreters() {
        use std::os::unix::fs::PermissionsExt;
        let td = tempfile::tempdir().unwrap();
        let write = |name: &str, body: &str| {
            let p = td.path().join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        let gone = write("omp-gone", "#!/usr/bin/env tf-no-such-runtime-7f3a\n");
        assert_eq!(missing_interpreter(&gone), Some(Interpreter::Env("tf-no-such-runtime-7f3a".into())));
        let sh = write("omp-sh", "#!/usr/bin/env sh\necho hi\n");
        assert_eq!(missing_interpreter(&sh), None, "sh is on every PATH");
        let abs = write("omp-abs", &format!("#!{}\n", td.path().join("nope/bun").display()));
        assert_eq!(missing_interpreter(&abs).map(|i| i.name()), Some("bun".into()));
        let bin = write("omp-bin", "\x7fELF....");
        assert_eq!(missing_interpreter(&bin), None);
        assert_eq!(missing_interpreter(&td.path().join("absent")), None);
    }
}
