//! `tf-hostd forward` (what `tf-forward` and the tool shims run): a command, a login shell or a
//! tool on the host a TeleFlock app forwards `<name>` to, with ssh's semantics. The command words
//! are joined with spaces for the other host's shell; no command opens a login shell. A terminal
//! is used there when stdin and stdout are terminals here (Unix callers), or with `-t`; never with
//! `-T`. stdin, stdout and stderr stream both ways; the exit status is the remote command's, 255
//! for anything that kept it from running, with one line on stderr saying why.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tf_proto::{FWD_CHUNK, ForwardKind, FwdEv, FwdPty};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::flow::Window;
use super::{CliRequest, ListReply, endpoint};
use crate::ipc::{BoxRead, BoxWrite};
use crate::paths::Paths;

/// Exit status for anything that kept the command from running (as ssh).
const FAILED: i32 = 255;
/// How long the relaying app and the other host may take to start the stream.
const OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

const HELP: &str = "\
Usage: tf-forward <name> [-t|-T] [--cwd DIR] [--] [command…]
       tf-forward --list

Runs a command on the host a TeleFlock app forwards <name> to (without a command: a login shell
there). The command words are joined with spaces and run by that user's shell; stdin, stdout and
stderr stream both ways, and the exit status is the command's (255 when it could not run).

  -t         use a terminal there (default: when stdin and stdout are terminals here)
  -T         never use a terminal there
  --cwd DIR  working directory there (default: the home directory)
  --list     the forwards this host can use and the TeleFlock apps relaying them
";

/// What the command line asks for.
#[derive(Debug, PartialEq)]
pub(crate) enum Cli {
    Help,
    List,
    Run(Run),
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Run {
    pub name: String,
    /// `-t` (`Some(true)`), `-T` (`Some(false)`), else decided by the caller's terminal.
    pub tty: Option<bool>,
    pub cwd: Option<String>,
    /// `--tool <tool>` (tool shims): run the tool with `words` as its arguments, exactly.
    pub tool: Option<String>,
    pub words: Vec<String>,
}

/// Options go before the name or between the name and the command; the first word after the name
/// that is not an option starts the command, and so does everything after `--`.
pub(crate) fn parse(args: &[String]) -> Result<Cli, String> {
    let mut run = Run::default();
    let mut name: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if name.is_some() && (!a.starts_with('-') || a == "-") {
            break;
        }
        match a {
            "--" => {
                i += 1;
                break;
            }
            "-h" | "--help" => return Ok(Cli::Help),
            "--list" if args.len() == 1 => return Ok(Cli::List),
            "--list" => return Err("--list takes no other arguments".into()),
            "--cwd" => {
                i += 1;
                run.cwd = Some(args.get(i).ok_or("--cwd needs a directory")?.clone());
            }
            "--tool" => {
                i += 1;
                run.tool = Some(args.get(i).ok_or("--tool needs a command name")?.clone());
            }
            s if s.starts_with("--cwd=") => run.cwd = Some(s["--cwd=".len()..].to_string()),
            s if s.len() > 1 && s.starts_with('-') && s[1..].bytes().all(|c| c == b't') => run.tty = Some(true),
            s if s.len() > 1 && s.starts_with('-') && s[1..].bytes().all(|c| c == b'T') => run.tty = Some(false),
            s if s.starts_with('-') && s != "-" => return Err(format!("unknown option {s} (tf-forward --help)")),
            s => name = Some(s.to_string()),
        }
        i += 1;
    }
    let name = name.ok_or("which forward? tf-forward <name> [command…] (tf-forward --list shows them)")?;
    if let Some(tool) = &run.tool
        && !super::valid_tool(tool)
    {
        return Err(format!("\"{tool}\" is not a command name"));
    }
    run.name = name;
    run.words = args[i..].to_vec();
    Ok(Cli::Run(run))
}

/// `tf-hostd forward <args>`: exits with the remote command's status (255: it could not run).
pub fn main(args: Vec<String>) -> ! {
    let code = match parse(&args) {
        Err(e) => fail(&e),
        Ok(cli) => match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Err(e) => fail(&format!("cannot start: {e}")),
            Ok(rt) => {
                let code = rt.block_on(async {
                    match cli {
                        Cli::Help => {
                            print!("{HELP}");
                            0
                        }
                        Cli::List => list().await,
                        Cli::Run(r) => stream(r).await,
                    }
                });
                // A read of stdin may still block a thread of the runtime until the next key or
                // line (a terminal nobody types into, an open pipe): dropping the runtime would
                // wait for it, so leave it behind.
                rt.shutdown_background();
                code
            }
        },
    };
    use std::io::Write;
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(code)
}

fn fail(why: &str) -> i32 {
    eprintln!("tf-forward: {why}");
    FAILED
}

async fn write_line<T: serde::Serialize>(w: &mut BoxWrite, value: &T) -> bool {
    let Ok(mut s) = serde_json::to_string(value) else { return false };
    s.push('\n');
    w.write_all(s.as_bytes()).await.is_ok() && w.flush().await.is_ok()
}

async fn read_line<T: serde::de::DeserializeOwned>(r: &mut BufReader<BoxRead>, line: &mut String) -> Option<T> {
    loop {
        line.clear();
        if !crate::clients::read_line(r, line).await.ok()? {
            return None;
        }
        if let Ok(v) = serde_json::from_str(line) {
            return Some(v);
        }
    }
}

async fn list() -> i32 {
    let paths = Paths::from_env();
    let Ok((r, mut w)) = endpoint::connect(&paths).await else {
        println!("No forwards: tf-hostd is not running on this host, so no TeleFlock app is connected.");
        return 0;
    };
    if !write_line(&mut w, &CliRequest::List).await {
        return fail("tf-hostd closed the connection");
    }
    let mut reader = BufReader::new(r);
    let Some(reply) = read_line::<ListReply>(&mut reader, &mut String::new()).await else {
        return fail("tf-hostd closed the connection");
    };
    let on_path = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d == std::path::Path::new(&reply.bin)));
    print!("{}", format_list(&reply, on_path));
    0
}

/// `tf-forward --list`'s text.
pub(crate) fn format_list(reply: &ListReply, bin_on_path: bool) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    if reply.forwards.is_empty() {
        out.push_str("No forwards: no TeleFlock app relays any to this host.\n");
        return out;
    }
    let mut tools = false;
    for f in &reply.forwards {
        let Some(o) = &f.offer else {
            let _ = writeln!(out, "{}: no TeleFlock app is connected to relay it (TeleFlock on {} did)", f.name, f.device);
            continue;
        };
        let state = match (o.ready, &o.reason) {
            (true, _) => "ready".to_string(),
            (false, Some(why)) => why.clone(),
            (false, None) => format!("{} is not connected to it", o.to),
        };
        let _ = writeln!(out, "{} → {}, relayed by TeleFlock on {}: {state}", f.name, o.to, f.device);
        let mut parts = vec![format!("shell: {}", if o.shell { "yes" } else { "no" })];
        if !o.tools.is_empty() {
            tools = true;
            parts.push(format!("tools: {}", o.tools.join(", ")));
        }
        if !o.ports.is_empty() {
            let ports: Vec<String> = o
                .ports
                .iter()
                .map(|p| match f.port_errors.iter().find(|e| e.listen == p.listen) {
                    Some(e) => format!("{} → {} ({})", p.listen, p.target, e.message),
                    None => format!("{} → {}", p.listen, p.target),
                })
                .collect();
            parts.push(format!("ports: {}", ports.join(", ")));
        }
        let _ = writeln!(out, "  {}", parts.join("   "));
    }
    if tools && !bin_on_path {
        let _ = writeln!(out, "Tools run by their name with {} first on PATH:", reply.bin);
        if cfg!(windows) {
            let _ = writeln!(out, "  set \"PATH={};%PATH%\"", reply.bin);
        } else {
            let _ = writeln!(out, "  export PATH=\"{}:$PATH\"", reply.bin);
        }
    }
    out
}

/// Opens the stream, then moves bytes until the remote program exits.
async fn stream(r: Run) -> i32 {
    let paths = Paths::from_env();
    let Ok((rd, mut wr)) = endpoint::connect(&paths).await else {
        return fail(&format!("no TeleFlock app is connected to relay to \"{}\" (tf-hostd is not running here)", r.name));
    };
    #[cfg(unix)]
    let terminal = super::pty::is_tty(0) && super::pty::is_tty(1);
    #[cfg(not(unix))]
    let terminal = false;
    let pty = r.tty.unwrap_or(terminal).then(|| {
        #[cfg(unix)]
        let (cols, rows) = super::pty::size(1).or_else(|| super::pty::size(0)).unwrap_or((80, 24));
        #[cfg(not(unix))]
        let (cols, rows) = (80, 24);
        FwdPty { cols, rows, term: std::env::var("TERM").ok().filter(|t| !t.is_empty()) }
    });
    let (kind, command, argv) = match (&r.tool, r.words.is_empty()) {
        (Some(tool), _) => (ForwardKind::Tool, None, Some(std::iter::once(tool.clone()).chain(r.words.iter().cloned()).collect())),
        (None, true) => (ForwardKind::Shell, None, None),
        (None, false) => (ForwardKind::Command, Some(r.words.join(" ")), None),
    };
    let open = FwdEv::Open { kind, name: r.name.clone(), command, argv, pty, cwd: r.cwd.clone(), port: None };
    if !write_line(&mut wr, &CliRequest::Open { open }).await {
        return fail("tf-hostd closed the connection");
    }
    let mut reader = BufReader::with_capacity(64 * 1024, rd);
    let mut line = String::new();
    let granted = match tokio::time::timeout(OPEN_TIMEOUT, read_line::<FwdEv>(&mut reader, &mut line)).await {
        Err(_) => return fail(&format!("no answer from the TeleFlock app relaying \"{}\" in {} s", r.name, OPEN_TIMEOUT.as_secs())),
        Ok(Some(FwdEv::Opened { pty })) => pty,
        Ok(Some(FwdEv::Close { error })) => return fail(error.as_deref().unwrap_or("the forward refused the stream")),
        Ok(Some(other)) => return fail(&format!("unexpected answer from tf-hostd: {other:?}")),
        Ok(None) => return fail("tf-hostd closed the connection"),
    };
    #[cfg(unix)]
    let raw = if granted && super::pty::is_tty(0) { super::pty::RawMode::enable(0).ok() } else { None };
    #[cfg(not(unix))]
    let _ = granted;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<FwdEv>();
    tokio::spawn(async move {
        while let Some(ev) = out_rx.recv().await {
            if !write_line(&mut wr, &ev).await {
                break;
            }
        }
    });
    let window = Arc::new(Window::default());
    tokio::spawn(pump_stdin(window.clone(), out_tx.clone()));
    #[cfg(unix)]
    if granted {
        let out = out_tx.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::{SignalKind, signal};
            let Ok(mut winch) = signal(SignalKind::window_change()) else { return };
            while winch.recv().await.is_some() {
                if let Some((cols, rows)) = super::pty::size(1).or_else(|| super::pty::size(0)) {
                    let _ = out.send(FwdEv::Resize { cols, rows });
                }
            }
        });
    }
    let mut stopped = signals();
    let (mut stdout, mut stderr) = (tokio::io::stdout(), tokio::io::stderr());
    let outcome: Result<i32, String> = loop {
        let ev = tokio::select! {
            ev = read_line::<FwdEv>(&mut reader, &mut line) => ev,
            sig = stopped.recv() => break Ok(128 + sig.unwrap_or(15)),
        };
        match ev {
            Some(FwdEv::Data { data, fd }) => {
                let Ok(bytes) = B64.decode(data.as_bytes()) else { break Err("tf-hostd sent data that is not base64".into()) };
                let written = if fd == 2 {
                    async { stderr.write_all(&bytes).await?; stderr.flush().await }.await
                } else {
                    async { stdout.write_all(&bytes).await?; stdout.flush().await }.await
                };
                if written.is_err() {
                    // Nobody reads our output any more (a closed pipe): like ssh, stop.
                    break Ok(FAILED);
                }
                let _ = out_tx.send(FwdEv::Ack { n: bytes.len() as u64 });
            }
            Some(FwdEv::Ack { n }) => window.ack(n),
            Some(FwdEv::Exit { code, signal }) => break Ok(code.or(signal.map(|s| 128 + s)).unwrap_or(FAILED)),
            Some(FwdEv::Close { error }) => break Err(error.unwrap_or_else(|| "the forward ended the stream".into())),
            Some(_) => {}
            None => break Err("lost the connection to tf-hostd".into()),
        }
    };
    #[cfg(unix)]
    drop(raw);
    match outcome {
        Ok(code) => code,
        Err(why) => fail(&why),
    }
}

/// stdin → the stream, within the window; its end is `eof`.
async fn pump_stdin(window: Arc<Window>, out: mpsc::UnboundedSender<FwdEv>) {
    let mut stdin = tokio::io::stdin();
    let mut buf = vec![0u8; FWD_CHUNK];
    loop {
        let Some(room) = window.reserve().await else { return };
        match stdin.read(&mut buf[..room]).await {
            Ok(0) | Err(_) => {
                let _ = out.send(FwdEv::Eof);
                return;
            }
            Ok(n) => {
                window.release(room - n);
                if out.send(FwdEv::Data { data: B64.encode(&buf[..n]), fd: 0 }).is_err() {
                    return;
                }
            }
        }
    }
}

/// Signals that end `tf-forward` (the stream closes with it, and the remote program is stopped):
/// their numbers.
fn signals() -> mpsc::UnboundedReceiver<i32> {
    let (tx, rx) = mpsc::unbounded_channel();
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        for (kind, n) in [(SignalKind::terminate(), libc::SIGTERM), (SignalKind::hangup(), libc::SIGHUP), (SignalKind::interrupt(), libc::SIGINT)] {
            let tx = tx.clone();
            if let Ok(mut s) = signal(kind) {
                tokio::spawn(async move {
                    if s.recv().await.is_some() {
                        let _ = tx.send(n);
                    }
                });
            }
        }
    }
    #[cfg(windows)]
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            let _ = tx.send(2);
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|a| a.to_string()).collect()
    }

    fn run(f: impl FnOnce(&mut Run)) -> Cli {
        let mut r = Run { name: "mac".into(), ..Run::default() };
        f(&mut r);
        Cli::Run(r)
    }

    #[test]
    fn parses_like_ssh() {
        assert_eq!(parse(&args(&["mac"])), Ok(run(|_| {})));
        assert_eq!(parse(&args(&["mac", "ls", "-la", "/tmp"])), Ok(run(|r| r.words = args(&["ls", "-la", "/tmp"]))));
        assert_eq!(parse(&args(&["mac", "-t", "--cwd", "/srv", "top"])), Ok(run(|r| (r.tty, r.cwd, r.words) = (Some(true), Some("/srv".into()), args(&["top"])))));
        assert_eq!(parse(&args(&["-T", "mac", "--cwd=~/x", "--", "-t", "x"])), Ok(run(|r| (r.tty, r.cwd, r.words) = (Some(false), Some("~/x".into()), args(&["-t", "x"])))));
        assert_eq!(parse(&args(&["mac", "-tt", "vim"])), Ok(run(|r| (r.tty, r.words) = (Some(true), args(&["vim"])))));
        // After the command starts, everything is the command's.
        assert_eq!(parse(&args(&["mac", "grep", "-t", "--cwd", "x"])), Ok(run(|r| r.words = args(&["grep", "-t", "--cwd", "x"]))));
        assert_eq!(parse(&args(&["mac", "-", "x"])), Ok(run(|r| r.words = args(&["-", "x"]))));
        // Tool shims: the arguments exactly, options included.
        assert_eq!(
            parse(&args(&["--tool", "agent-browser", "mac", "--", "--headed", "-t", "a b"])),
            Ok(run(|r| (r.tool, r.words) = (Some("agent-browser".into()), args(&["--headed", "-t", "a b"]))))
        );
        assert_eq!(parse(&args(&["--list"])), Ok(Cli::List));
        assert_eq!(parse(&args(&["--help"])), Ok(Cli::Help));
        assert_eq!(parse(&args(&["mac", "-h"])), Ok(Cli::Help));
        assert!(parse(&args(&[])).unwrap_err().starts_with("which forward?"));
        assert_eq!(parse(&args(&["--list", "mac"])).unwrap_err(), "--list takes no other arguments");
        assert_eq!(parse(&args(&["mac", "-x"])).unwrap_err(), "unknown option -x (tf-forward --help)");
        assert_eq!(parse(&args(&["mac", "--cwd"])).unwrap_err(), "--cwd needs a directory");
        assert_eq!(parse(&args(&["--tool", "../x", "mac"])).unwrap_err(), "\"../x\" is not a command name");
    }

    #[test]
    #[cfg(unix)]
    fn the_list_shows_what_relays_what() {
        use tf_proto::{ForwardPort, ForwardPortError, FwdOffer};
        let offer = FwdOffer {
            name: "mac".into(),
            to: "Studio Mac".into(),
            shell: true,
            tools: vec!["agent-browser".into()],
            ports: vec![ForwardPort { listen: 9222, target: 9222 }, ForwardPort { listen: 3000, target: 8080 }],
            ready: true,
            reason: None,
        };
        let reply = ListReply {
            forwards: vec![
                super::super::ListEntry {
                    name: "mac".into(),
                    offer: Some(offer),
                    device: "laptop".into(),
                    port_errors: vec![ForwardPortError { listen: 3000, message: "port 3000 is in use on this host".into() }],
                },
                super::super::ListEntry { name: "pc".into(), offer: None, device: "phone".into(), port_errors: vec![] },
            ],
            bin: "/h/.teleflock/forward/bin".into(),
        };
        let text = format_list(&reply, false);
        assert_eq!(
            text,
            "mac → Studio Mac, relayed by TeleFlock on laptop: ready\n  shell: yes   tools: agent-browser   ports: 9222 → 9222, 3000 → 8080 (port 3000 is in use on this host)\npc: no TeleFlock app is connected to relay it (TeleFlock on phone did)\nTools run by their name with /h/.teleflock/forward/bin first on PATH:\n  export PATH=\"/h/.teleflock/forward/bin:$PATH\"\n"
        );
        assert!(!format_list(&reply, true).contains("export PATH"));
        assert_eq!(format_list(&ListReply::default(), false), "No forwards: no TeleFlock app relays any to this host.\n");
    }
}
