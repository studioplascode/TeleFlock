//! POSIX quoting and the command line SSH exec channels and WSL run.
//!
//! On its way to the host a command passes layers that each split words their own way. WSL: the
//! Windows command line wsl.exe parses (`CommandLineToArgvW` in WSL from the Store; other wsl.exe
//! builds may differ). SSH: the user's shell, which sshd runs the exec request through. Both: the
//! user's login shell, which has to run so profile files put `~/.local/bin` on PATH, and which may
//! be fish, nushell or any other shell. Only POSIX `sh` ever parses the command itself:
//! [`bootstrap_argv`] carries it base64-encoded through the other layers in words no parser treats
//! specially ([`is_plain`]), and the login shell runs one fixed line, [`LOGIN_COMMAND`].
//!
//! [`shell_quote`] is for `sh` (and also valid fish syntax): a single quote or backslash is
//! emitted *outside* single quotes as `\'` / `\\`, which sh, bash, zsh and fish read as the
//! literal character; everything else goes inside single quotes. Nushell, for one, reads `\'`
//! differently, which is why no other shell is handed quoted text.

use crate::Cmd;

/// Decodes `$1` (the base64 of [`stage2`]) and runs it in this `sh`. Plain characters only, so the
/// Windows command line and every shell read it the same way: an empty `IFS` and `set -f` keep the
/// unquoted `$X` one word (the decoded script restores both first).
///
/// This `sh` runs before any profile has set `PATH`, so the usual directories are appended while
/// decoding (NixOS, Guix and some NAS boxes keep coreutils off the bare PATH; Homebrew's is not on
/// it either) and the PATH comes back before the script runs. The decoders, first that works:
/// `base64 -d`, `base64 -D` (macOS 12 and older), `openssl base64 -d -A`, `python3 -m base64 -d`,
/// `perl` with MIME::Base64 (`+` instead of a space: no quotes allowed). None: exit 127 with a
/// message that says what to install.
const BOOTSTRAP: &str = "IFS=;set -f;P=$PATH;PATH=${PATH:+$PATH:}/usr/local/bin:/opt/homebrew/bin:/run/current-system/sw/bin:/usr/bin:/bin;\
X=$(echo $1|base64 -d 2>/dev/null||echo $1|base64 -D 2>/dev/null||echo $1|openssl base64 -d -A 2>/dev/null||echo $1|python3 -m base64 -d 2>/dev/null||perl -MMIME::Base64 -e print+decode_base64+shift $1 2>/dev/null)&&PATH=$P||{ echo teleflock bootstrap: no base64 decoder found on the host, looked for base64, openssl, python3 and perl>&2;exit 127;};eval $X";

/// The one line the user's login shell runs: hand the command in `$TF_EXEC` to POSIX `sh`. Words
/// and a single-quoted string with no quote or backslash inside, which sh, bash, zsh, ksh, fish
/// and nushell all read the same way.
pub const LOGIN_COMMAND: &str = r#"exec sh -c 'eval "$TF_EXEC"'"#;

/// `$SHELL`s that run as `-lc` [`LOGIN_COMMAND`] (a `case` pattern on the basename). Any other
/// (csh, tcsh, elvish, xonsh, pwsh, nologin …) is replaced by `sh -l`, which reads /etc/profile
/// and ~/.profile.
const LOGIN_SHELLS: &str = "sh|ash|dash|bash*|zsh*|ksh*|mksh|lksh|oksh|yash|fish|nu";

fn is_safe(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '=' | ':' | ',' | '+' | '@')
}

/// Quote one word so any POSIX shell (and fish) reads it back verbatim.
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(is_safe) {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len() + 2);
    let mut open = false;
    for c in s.chars() {
        if c == '\'' || c == '\\' {
            if open {
                out.push('\'');
                open = false;
            }
            out.push('\\');
            out.push(c);
        } else {
            if !open {
                out.push('\'');
                open = true;
            }
            out.push(c);
        }
    }
    if open {
        out.push('\'');
    }
    if out.is_empty() {
        out.push_str("''");
    }
    out
}

/// Quote a working directory, keeping a leading `~` / `~/` expandable.
fn quote_dir(dir: &str) -> String {
    if dir == "~" {
        "~".into()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        if rest.is_empty() { "~/".into() } else { format!("~/{}", shell_quote(rest)) }
    } else {
        shell_quote(dir)
    }
}

/// The inner command line: `[cd DIR && ]exec [env K=V …] ARGV…`.
pub fn inner_command(cmd: &Cmd) -> String {
    let mut s = String::new();
    if let Some(dir) = cmd.cwd.as_deref().filter(|d| !d.is_empty()) {
        s.push_str("cd ");
        s.push_str(&quote_dir(dir));
        s.push_str(" && ");
    }
    s.push_str("exec");
    if !cmd.env.is_empty() {
        s.push_str(" env");
        for (k, v) in &cmd.env {
            s.push(' ');
            s.push_str(&shell_quote(&format!("{k}={v}")));
        }
    }
    for a in &cmd.argv {
        s.push(' ');
        s.push_str(&shell_quote(a));
    }
    s
}

/// A word every Windows command-line parser and every shell splits off unchanged: not empty,
/// printable ASCII and spaces, no quote or backslash. Rust quotes a word with a space as `"…"`,
/// which they all group the same way; quotes and backslashes inside are where they differ.
pub fn is_plain(word: &str) -> bool {
    !word.is_empty() && word.bytes().all(|b| b == b' ' || (b.is_ascii_graphic() && !matches!(b, b'"' | b'\'' | b'\\')))
}

/// Standard base64 with padding.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let byte = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
        let n = (byte(0) << 16) | (byte(1) << 8) | byte(2);
        for i in 0..4 {
            out.push(if i <= chunk.len() { char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]) } else { '=' });
        }
    }
    out
}

/// The script [`BOOTSTRAP`] decodes and runs: `cmd` exported as `TF_EXEC` (which unsets itself
/// before the program starts), then the login shell on [`LOGIN_COMMAND`].
fn stage2(cmd: &Cmd) -> String {
    format!(
        "unset IFS;set +f\nTF_EXEC={}\nexport TF_EXEC\nL=${{SHELL:-sh}}\ncase ${{L##*/}} in {LOGIN_SHELLS}) ;; *) L=sh ;; esac\nexec \"$L\" -lc {}\n",
        shell_quote(&format!("unset TF_EXEC;{}", inner_command(cmd))),
        shell_quote(LOGIN_COMMAND),
    )
}

/// Words that run `cmd` in the user's login shell: `sh -c BOOTSTRAP sh <base64 script>`, every
/// one [`is_plain`]. The command line grows by a third plus ~250 bytes.
pub fn bootstrap_argv(cmd: &Cmd) -> Vec<String> {
    vec!["sh".into(), "-c".into(), BOOTSTRAP.into(), "sh".into(), base64(stage2(cmd).as_bytes())]
}

/// The full command string sent in an SSH `exec` request, which the user's shell parses: `exec`
/// and the [`bootstrap_argv`] words, which every shell reads the same way. Every level `exec`s the
/// next (user shell → sh → login shell → sh → program), so the command is the channel's only
/// process and an SSH `signal` reaches it directly.
pub fn remote_command(cmd: &Cmd) -> String {
    let words = bootstrap_argv(cmd).iter().map(|w| shell_quote(w)).collect::<Vec<_>>().join(" ");
    format!("exec {words}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;

    #[test]
    fn quotes_words() {
        assert_eq!(shell_quote("herdr"), "herdr");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(r"a\b"), r"'a'\\'b'");
        assert_eq!(shell_quote("'"), r"\'");
        assert_eq!(shell_quote("$HOME"), "'$HOME'");
        assert_eq!(shell_quote("~"), "'~'");
    }

    #[test]
    fn builds_inner_command() {
        let cmd = Cmd::new(["herdr", "agent", "list", "--json"]).cwd("~/src/my repo").env("HERDR_SESSION", "lab 1");
        assert_eq!(inner_command(&cmd), "cd ~/'src/my repo' && exec env 'HERDR_SESSION=lab 1' herdr agent list --json");
        let cmd = Cmd::new(["echo", "x"]);
        assert_eq!(inner_command(&cmd), "exec echo x");
    }

    #[test]
    fn encodes_base64() {
        // RFC 4648 §10.
        for (raw, enc) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(raw.as_bytes()), enc);
            assert_eq!(base64_decode(enc), raw.as_bytes());
        }
    }

    /// The command travels base64-encoded behind a fixed bootstrap; the login shell gets a fixed line.
    #[test]
    fn bootstrap_carries_the_command_encoded() {
        let cmd = Cmd::new(["echo", "it's"]).cwd("~");
        let words = bootstrap_argv(&cmd);
        assert_eq!(words[..4], ["sh", "-c", BOOTSTRAP, "sh"]);
        let script = String::from_utf8(base64_decode(&words[4])).unwrap();
        assert_eq!(script, stage2(&cmd));
        assert!(script.contains(&format!("\nTF_EXEC={}\n", shell_quote(r"unset TF_EXEC;cd ~ && exec echo 'it'\''s'"))), "{script}");
        assert!(script.ends_with(&format!("exec \"$L\" -lc {}\n", shell_quote(LOGIN_COMMAND))), "{script}");
        assert_eq!(remote_command(&cmd), format!("exec sh -c '{BOOTSTRAP}' sh {}", words[4]));
    }

    /// Whatever the command, every word handed to wsl.exe or the user's shell is plain.
    #[test]
    fn bootstrap_words_are_plain() {
        let mut rng = Rng::new(1);
        for _ in 0..500 {
            let n = 1 + rng.below(5);
            let mut cmd = Cmd::new((0..n).map(|_| rng.word()));
            cmd.env = (0..rng.below(3)).map(|i| (format!("K{i}"), rng.word())).collect();
            cmd.cwd = (rng.below(2) == 0).then(|| rng.word());
            for w in bootstrap_argv(&cmd) {
                assert!(is_plain(&w), "{w:?}");
            }
        }
        for w in ["", "a\"b", "a'b", r"a\b", "a\tb", "a\nb", "a\rb", "é"] {
            assert!(!is_plain(w), "{w:?}");
        }
    }

    /// Spawns the bootstrap the way a host with a bare PATH does: only `sh` is on it. The login
    /// shell is a stand-in that runs the fixed command without reading a profile (which would
    /// set PATH itself).
    #[cfg(unix)]
    fn run_with_bare_path(words: &[String], bare: &std::path::Path) -> std::process::Output {
        let sh = bare.join("sh");
        if !sh.exists() {
            std::os::unix::fs::symlink("/bin/sh", &sh).unwrap();
        }
        let shell = bare.join("shells/nu");
        std::fs::create_dir_all(shell.parent().unwrap()).unwrap();
        tf_hostd::test_exe::write_exe(&shell, "#!/bin/sh\nexec sh -c \"$2\"\n");
        std::process::Command::new("/bin/sh")
            .args(&words[1..])
            .env_clear()
            .env("HOME", bare)
            .env("SHELL", &shell)
            .env("PATH", bare)
            .current_dir("/")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    }

    /// `base64` is not on the pre-login PATH (NixOS, Homebrew, NAS boxes): the usual directories are
    /// searched while decoding, and the program still gets the PATH the host gave.
    #[cfg(unix)]
    #[test]
    fn bootstrap_finds_a_decoder_off_the_bare_path_and_restores_it() {
        if !std::path::Path::new("/usr/bin/base64").exists() && !std::path::Path::new("/bin/base64").exists() {
            return;
        }
        let dir = TempDir::new("bare-path");
        let words = bootstrap_argv(&Cmd::new(["sh", "-c", "echo \"$PATH\""]));
        let out = run_with_bare_path(&words, &dir.0);
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), dir.0.to_string_lossy(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// A `base64` that is there but doesn't decode (or isn't GNU/BSD) falls through to the next decoder.
    #[cfg(unix)]
    #[test]
    fn bootstrap_falls_back_when_base64_is_unusable() {
        let dir = TempDir::new("bad-base64");
        let fake = dir.0.join("base64");
        tf_hostd::test_exe::write_exe(&fake, "#!/bin/sh\nexit 1\n");
        let have = |t: &str| ["/usr/bin", "/bin", "/usr/local/bin"].iter().any(|d| std::path::Path::new(d).join(t).exists());
        if !(have("openssl") || have("python3") || have("perl")) {
            return;
        }
        let words = bootstrap_argv(&Cmd::new(["sh", "-c", "echo ran"]));
        let out = run_with_bare_path(&words, &dir.0);
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ran", "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// Each decoder of [`BOOTSTRAP`] decodes the script on its own (those installed here).
    #[cfg(unix)]
    #[test]
    fn every_bootstrap_decoder_decodes() {
        let start = BOOTSTRAP.find("X=$(").unwrap() + 4;
        let decoders = BOOTSTRAP[start..BOOTSTRAP.find(")&&").unwrap()].split("||").collect::<Vec<_>>();
        assert_eq!(decoders.len(), 5, "{decoders:?}");
        let encoded = base64(b"echo ran\nexit 3\n".as_slice());
        for d in decoders {
            let tool = d.split('|').next_back().unwrap().split(' ').find(|w| !w.starts_with('-') && !w.is_empty()).unwrap();
            if std::process::Command::new("sh").args(["-c", &format!("command -v {tool}")]).output().map(|o| !o.status.success()).unwrap_or(true) {
                continue;
            }
            let out = std::process::Command::new("sh").args(["-c", &format!("IFS=;set -f;{d}"), "sh", &encoded]).output().unwrap();
            // `base64 -D` is BSD-only and `-d` is not: whoever accepts the flag must decode right.
            if out.status.success() {
                assert_eq!(String::from_utf8_lossy(&out.stdout), "echo ran\nexit 3\n", "{d}");
            } else {
                assert!(d.contains("base64 -D"), "{d}: {}", String::from_utf8_lossy(&out.stderr));
            }
        }
    }

    /// Random commands run on the host exactly as given (argv, env, cwd, no `TF_EXEC` left over)
    /// in every login shell. `TF_TEST_LOGIN_SHELLS` adds real ones (nushell, fish …).
    #[cfg(unix)]
    #[test]
    fn commands_run_exactly_in_any_login_shell() {
        let dir = TempDir::new("login-shells");
        let home = dir.0.join("home");
        let odd = "d 'q' \"x\" \\ $y";
        std::fs::create_dir_all(home.join(odd)).unwrap();
        let abs = home.join(odd).to_string_lossy().into_owned();
        let cwds = [(None, "/".to_string()), (Some("~".to_string()), home.to_string_lossy().into_owned()), (Some(format!("~/{odd}")), abs.clone()), (Some(abs.clone()), abs)];
        let mut rng = Rng::new(2);
        for shell in login_shells(&dir.0) {
            for case in 0..40 {
                let args: Vec<String> = (0..rng.below(6)).map(|_| rng.word()).collect();
                let env: Vec<(String, String)> = (0..rng.below(3)).map(|i| (format!("TF_T{i}"), rng.word())).collect();
                let (cwd, pwd) = &cwds[case % cwds.len()];
                let vars: String = env.iter().map(|(k, _)| format!(" \"${k}\"")).collect();
                let mut cmd = Cmd::new(["sh", "-c", &format!("printf '%s\\0' \"$PWD\" \"${{TF_EXEC-unset}}\"{vars} \"$@\""), "sh"]);
                cmd.argv.extend(args.iter().cloned());
                cmd.env = env.clone();
                cmd.cwd = cwd.clone();
                let out = run_on_host(&bootstrap_argv(&cmd), &shell, &home, b"");
                let mut want = vec![pwd.clone(), "unset".to_string()];
                want.extend(env.into_iter().map(|(_, v)| v));
                want.extend(args);
                assert_eq!(fields(&out.stdout), want, "{} case {case}: {}", shell.display(), String::from_utf8_lossy(&out.stderr));
            }
        }
        assert_eq!(strict_calls(&dir.0), 40, "the strict login shell ran each case");
    }

    /// The login profile still applies (`~/.local/bin` from `~/.profile`), also when `$SHELL` has
    /// no `-lc` (tcsh) or is unset: then `sh -l` reads the profile.
    #[cfg(unix)]
    #[test]
    fn login_profile_puts_local_bin_on_path() {
        use std::path::{Path, PathBuf};
        let dir = TempDir::new("login-path");
        let home = dir.0.join("home");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(home.join(".profile"), "PATH=\"$HOME/.local/bin:$PATH\"\n").unwrap();
        let exe = |path: &Path, text: &str| tf_hostd::test_exe::write_exe(path, text);
        exe(&bin.join("tf-hello"), "#!/bin/sh\necho \"hello $*\"\n");
        let tcsh = dir.0.join("tcsh");
        exe(&tcsh, "#!/bin/sh\necho \"Unknown option: $1\" >&2\nexit 1\n");
        let mut shells = vec![PathBuf::from("/bin/sh"), strict_login_shell(&dir.0), tcsh, PathBuf::new()];
        shells.extend([PathBuf::from("/bin/bash")].into_iter().filter(|p| p.exists()));
        for shell in shells {
            let out = run_on_host(&bootstrap_argv(&Cmd::new(["tf-hello", "a b"])), &shell, &home, b"");
            assert_eq!(String::from_utf8_lossy(&out.stdout), "hello a b\n", "{}: {}", shell.display(), String::from_utf8_lossy(&out.stderr));
        }
        assert_eq!(strict_calls(&dir.0), 1, "the strict login shell ran (the tcsh fake did not)");
    }

    /// stdin reaches the program untouched (the upload path): nothing on the way reads from it.
    #[cfg(unix)]
    #[test]
    fn stdin_reaches_the_program() {
        let dir = TempDir::new("stdin");
        let blob: Vec<u8> = (0..1u32 << 20).map(|i| (i % 251) as u8).collect();
        for shell in login_shells(&dir.0) {
            let out = run_on_host(&bootstrap_argv(&Cmd::new(["sh", "-c", "cat > up.bin && wc -c < up.bin"]).cwd("~")), &shell, &dir.0, &blob);
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), blob.len().to_string(), "{}: {}", shell.display(), String::from_utf8_lossy(&out.stderr));
            assert_eq!(std::fs::read(dir.0.join("up.bin")).unwrap(), blob);
        }
        assert_eq!(strict_calls(&dir.0), 1, "the strict login shell ran");
    }

    /// Round-trip hostile arguments through a real `sh` (and fish if installed).
    #[test]
    fn round_trips_through_real_shells() {
        let args = ["plain", "", "with space", "it's", r"back\slash", r"\\", "$HOME `id` $(id)", "*?[a]{b,c}~", "new\nline", "émoji 🐑", "-n", "'", "\"dq\""];
        for shell in ["sh", "bash", "fish"] {
            if std::process::Command::new(shell).arg("-c").arg("true").output().map(|o| !o.status.success()).unwrap_or(true) {
                continue;
            }
            let line = format!("printf '%s\\0' {}", args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" "));
            let out = std::process::Command::new(shell).arg("-c").arg(&line).output().unwrap();
            let got: Vec<String> = out.stdout.split(|b| *b == 0).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
            assert_eq!(&got[..args.len()], &args[..], "shell {shell}");
        }
    }
}
