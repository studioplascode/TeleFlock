//! Test-only helpers: random words, a temp dir, running bootstrap words the way a host does, and
//! a model of how a Windows command line reaches Linux through wsl.exe.
//!
//! The model: Rust std flattens the `Command` args into one command line (`make_command_line`,
//! `Quote::Auto`); wsl.exe reads its own options up to `--exec` (WslClient.cpp,
//! `ParseLegacyArguments` + `helpers::ParseArgument`) and splits the rest. WSL from the Store
//! splits it with `CommandLineToArgvW`; other builds may not, so [`Rules`] also holds the plausible
//! alternatives, and the words TeleFlock hands wsl.exe must come out the same under all of them.

#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::sync::atomic::{AtomicUsize, Ordering};

/// xorshift64*: deterministic, so a failing case reproduces.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    /// A word built from what parsers and shells treat specially: quotes, backslashes, `$`, globs,
    /// tabs, newlines, CR, control and non-ASCII characters. Sometimes empty, sometimes long.
    pub fn word(&mut self) -> String {
        const POOL: &[&str] = &[
            "a", "Z", "0", "-", " ", "  ", "\t", "\n", "\r\n", "'", "\"", "\\", "\\\\", "\\\"", "'\\''", "$", "$HOME", "`", "$(id)", "*",
            "?", "[a]", "{b,c}", "~", "#", "!", "%PATH%", "^", "&", "|", ";", "<", ">", "(", ")", "=", "é", "🐑", "中文", "\u{7f}", "\u{1b}",
        ];
        let len = match self.below(10) {
            0 => 0,
            1 => 100 + self.below(400),
            _ => 1 + self.below(12),
        };
        (0..len).map(|_| POOL[self.below(POOL.len())]).collect()
    }
}

/// A fresh temp dir (removed on drop).
#[cfg(unix)]
pub struct TempDir(pub PathBuf);

#[cfg(unix)]
impl TempDir {
    pub fn new(tag: &str) -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("tf-transport-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}

#[cfg(unix)]
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A login shell that runs nothing but [`crate::quote::LOGIN_COMMAND`] (after `~/.profile`), so
/// whatever a real login shell's syntax, it never has to parse more than that. It sits at
/// `dir/strict/nu`: a name TeleFlock runs as a login shell (others fall back to `sh -l`), and it
/// logs each call to `dir/strict/calls`.
#[cfg(unix)]
pub fn strict_login_shell(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir.join("strict")).unwrap();
    let path = dir.join("strict/nu");
    let script = format!(
        "#!/bin/sh\necho \"$2\" >> \"$(dirname \"$0\")/calls\"\nif [ \"$1\" != -lc ] || [ \"$2\" != {} ]; then echo \"strict login shell: refusing $*\" >&2; exit 2; fi\n[ -r \"$HOME/.profile\" ] && . \"$HOME/.profile\"\nexec sh -c \"$2\"\n",
        crate::quote::shell_quote(crate::quote::LOGIN_COMMAND)
    );
    tf_hostd::test_exe::write_exe(&path, script);
    path
}

/// How often [`strict_login_shell`] in `dir` ran.
#[cfg(unix)]
pub fn strict_calls(dir: &Path) -> usize {
    std::fs::read_to_string(dir.join("strict/calls")).map(|s| s.lines().count()).unwrap_or(0)
}

/// The login shells to run commands through: `sh`, [`strict_login_shell`], the usual ones that
/// are installed, and `TF_TEST_LOGIN_SHELLS` (`:`-separated paths, e.g. nushell or fish).
#[cfg(unix)]
pub fn login_shells(dir: &Path) -> Vec<PathBuf> {
    let mut shells = vec![PathBuf::from("/bin/sh"), strict_login_shell(dir)];
    shells.extend(["/bin/bash", "/usr/bin/zsh", "/usr/bin/fish", "/usr/bin/nu"].iter().map(PathBuf::from).filter(|p| p.exists()));
    shells.extend(std::env::var("TF_TEST_LOGIN_SHELLS").unwrap_or_default().split(':').filter(|s| !s.is_empty()).map(PathBuf::from));
    shells
}

/// Runs `words` (what reaches Linux) like WSL or sshd does: a clean environment with `home` and
/// login shell `shell`, from `/`. Pre-creates nushell's config files so it prints no first-run notice.
#[cfg(unix)]
pub fn run_on_host(words: &[String], shell: &Path, home: &Path, stdin: &[u8]) -> std::process::Output {
    use std::io::Write;
    use std::process::Stdio;
    let nu = home.join(".config/nushell");
    std::fs::create_dir_all(&nu).unwrap();
    for f in ["env.nu", "config.nu"] {
        if !nu.join(f).exists() {
            std::fs::write(nu.join(f), "").unwrap();
        }
    }
    let mut child = std::process::Command::new(&words[0])
        .args(&words[1..])
        .env_clear()
        .env("HOME", home)
        .env("SHELL", shell)
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("LANG", "C.UTF-8")
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    // A command that never reads stdin closes it early: that is its choice.
    let _ = input.write_all(stdin);
    drop(input);
    child.wait_with_output().unwrap()
}

/// NUL-separated fields (the last one terminated).
#[cfg(unix)]
pub fn fields(out: &[u8]) -> Vec<String> {
    let mut v: Vec<String> = out.split(|b| *b == 0).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
    v.pop();
    v
}

/// Rust std's `make_command_line` for `Command::new(argv[0]).args(&argv[1..])`
/// (library/std/src/sys/args/windows.rs, `Quote::Auto`): the program in quotes; an argument in
/// quotes when it is empty or has a space or tab; backslashes doubled before a quote, which gets
/// one more.
pub fn rust_command_line(argv: &[String]) -> String {
    let mut s = format!("\"{}\"", argv[0]);
    for a in &argv[1..] {
        s.push(' ');
        let quote = a.is_empty() || a.contains([' ', '\t']);
        if quote {
            s.push('"');
        }
        let mut backslashes = 0;
        for c in a.chars() {
            if c == '\\' {
                backslashes += 1;
            } else {
                if c == '"' {
                    s.extend(std::iter::repeat_n('\\', backslashes + 1));
                }
                backslashes = 0;
            }
            s.push(c);
        }
        if quote {
            s.extend(std::iter::repeat_n('\\', backslashes));
            s.push('"');
        }
    }
    s
}

fn blank(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// What wsl.exe hands its exec-mode splitter: the program name skipped (quotes toggle, no
/// escapes), options read as space/tab-separated tokens without quote handling (`-d <name>`), and
/// the raw rest after `--exec`. `None` when an option is not one of those.
pub fn after_exec(line: &str) -> Option<&str> {
    let mut rest = line;
    let mut quoted = false;
    while let Some(c) = rest.chars().next() {
        if !quoted && blank(c) {
            break;
        }
        quoted ^= c == '"';
        rest = &rest[c.len_utf8()..];
    }
    let token = |s: &str| -> (String, usize) {
        let t = s.trim_start_matches(blank);
        let end = t.find(blank).unwrap_or(t.len());
        (t[..end].to_owned(), s.len() - t.len() + end)
    };
    loop {
        let (arg, used) = token(rest);
        rest = rest[used..].trim_start_matches(blank);
        match arg.as_str() {
            "-d" | "--distribution" => {
                let (_, used) = token(rest);
                rest = rest[used..].trim_start_matches(blank);
            }
            "-e" | "--exec" => return Some(rest),
            _ => return None,
        }
    }
}

/// Ways the text after `--exec` may be split into the Linux argv.
#[derive(Clone, Copy, Debug)]
pub enum Rules {
    /// shell32 `CommandLineToArgvW` (WSL from the Store: WslClient.cpp, exec mode), as Wine
    /// implements it.
    CommandLineToArgvW,
    /// `"` groups and is dropped; backslashes are literal.
    NoEscapes,
    /// `"` groups; a backslash escapes whatever follows.
    BackslashEscapesAny,
    /// `"` groups; only `\"` is an escape.
    EscapedQuoteOnly,
    /// `"` and `'` group; a backslash escapes whatever follows.
    SingleAndDoubleQuotes,
}

impl Rules {
    pub const ALL: [Self; 5] = [Self::CommandLineToArgvW, Self::NoEscapes, Self::BackslashEscapesAny, Self::EscapedQuoteOnly, Self::SingleAndDoubleQuotes];

    pub fn split(self, s: &str) -> Vec<String> {
        match self {
            Self::CommandLineToArgvW => command_line_to_argv(s),
            Self::NoEscapes => tokens(s, false, false, false),
            Self::BackslashEscapesAny => tokens(s, true, false, false),
            Self::EscapedQuoteOnly => tokens(s, false, true, false),
            Self::SingleAndDoubleQuotes => tokens(s, true, false, true),
        }
    }
}

/// Wine's `CommandLineToArgvW` (dlls/shcore/main.c), which follows Windows: the first word is a
/// program name (up to the next quote, or blank); then `2n` backslashes + `"` → `n` backslashes and
/// a quote toggle, `2n+1` + `"` → `n` backslashes and a literal `"`, and `""` inside quotes counts
/// toward a literal quote every third.
fn command_line_to_argv(s: &str) -> Vec<String> {
    let c: Vec<char> = s.chars().collect();
    let n = c.len();
    let mut i = 0;
    let mut cur = String::new();
    if i < n && c[i] == '"' {
        i += 1;
        while i < n && c[i] != '"' {
            cur.push(c[i]);
            i += 1;
        }
        i = (i + 1).min(n);
    } else {
        while i < n && !blank(c[i]) {
            cur.push(c[i]);
            i += 1;
        }
    }
    let mut args = vec![std::mem::take(&mut cur)];
    while i < n && blank(c[i]) {
        i += 1;
    }
    if i == n {
        return args;
    }
    let (mut quotes, mut backslashes) = (0, 0);
    while i < n {
        let ch = c[i];
        if blank(ch) && quotes == 0 {
            args.push(std::mem::take(&mut cur));
            backslashes = 0;
            while i < n && blank(c[i]) {
                i += 1;
            }
            if i == n {
                return args;
            }
        } else if ch == '\\' {
            cur.push(ch);
            backslashes += 1;
            i += 1;
        } else if ch == '"' {
            for _ in 0..backslashes / 2 {
                cur.pop();
            }
            if backslashes % 2 == 1 {
                cur.pop();
                cur.push('"');
            } else {
                quotes += 1;
            }
            i += 1;
            backslashes = 0;
            while i < n && c[i] == '"' {
                quotes += 1;
                if quotes == 3 {
                    cur.push('"');
                    quotes = 0;
                }
                i += 1;
            }
            if quotes == 2 {
                quotes = 0;
            }
        } else {
            cur.push(ch);
            backslashes = 0;
            i += 1;
        }
    }
    args.push(cur);
    args
}

/// A simple splitter: blanks separate words outside quotes; `"` (and `'` with `single`) group
/// and are dropped; a backslash escapes the next character (`escape_any`) or only a `"`.
fn tokens(s: &str, escape_any: bool, escape_quote: bool, single: bool) -> Vec<String> {
    let c: Vec<char> = s.chars().collect();
    let (mut args, mut cur, mut quote, mut open) = (Vec::new(), String::new(), None::<char>, false);
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if quote.is_none() && blank(ch) {
            if open {
                args.push(std::mem::take(&mut cur));
                open = false;
            }
            i += 1;
            continue;
        }
        open = true;
        if ch == '\\' && i + 1 < c.len() && (escape_any || (escape_quote && c[i + 1] == '"')) {
            cur.push(c[i + 1]);
            i += 2;
            continue;
        }
        if ch == '"' || (single && ch == '\'') {
            match quote {
                None => {
                    quote = Some(ch);
                    i += 1;
                    continue;
                }
                Some(q) if q == ch => {
                    quote = None;
                    i += 1;
                    continue;
                }
                Some(_) => {}
            }
        }
        cur.push(ch);
        i += 1;
    }
    if open {
        args.push(cur);
    }
    args
}

/// Standard base64 back to bytes (padding and anything outside the alphabet skipped).
pub fn base64_decode(s: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0);
    for v in s.bytes().filter_map(value) {
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}
