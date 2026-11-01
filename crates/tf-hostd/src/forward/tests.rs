//! The host's side of forwarding in-process: streams an app opens here (commands, terminals,
//! tools, ports, early ends), offers (shims, port listeners, the newest app wins), and
//! `tf-forward`'s endpoint relaying to the app. The whole chain through a real app core and two
//! daemons is `crates/tf-client/tests/forward.rs`.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tf_proto::{ClientInfo, FWD_CHUNK, FWD_WINDOW, ForwardPort, FwdPty};
use tokio::io::AsyncWriteExt;

use super::*;
use crate::clients::Features;

fn client(id: &str) -> ClientHandle {
    let info = ClientInfo { app: "test".into(), version: "0".into(), platform: "linux".into(), device: format!("{id}-device"), features: None };
    ClientHandle::with_features(id.into(), info, Features { forward: true, ..Features::default() })
}

fn forwarder() -> (Forwarder, Paths, tempfile::TempDir) {
    let td = tempfile::tempdir().unwrap();
    let paths = Paths::new(td.path().join("tf"), true);
    let fwd = Forwarder::start(&paths, CancellationToken::new());
    (fwd, paths, td)
}

/// Everything sent to a client, parsed.
struct Inbox {
    c: ClientHandle,
    got: Vec<ServerMsg>,
}

impl Inbox {
    fn new(c: &ClientHandle) -> Self {
        Inbox { c: c.clone(), got: Vec::new() }
    }

    /// Waits until `f` holds for what arrived so far.
    async fn until(&mut self, what: &str, f: impl Fn(&[ServerMsg]) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let mut batch = Vec::new();
            self.c.take_batch(&mut batch);
            self.got.extend(batch.iter().map(|l| serde_json::from_str::<ServerMsg>(l).unwrap()));
            if f(&self.got) {
                return;
            }
            assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}: {:?}", self.got);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// The events of stream `sid` so far.
    fn events(&self, sid: u64) -> Vec<FwdEv> {
        events_of(&self.got, sid)
    }

    /// Stream `sid`'s events once it ended (exit or close).
    async fn ended(&mut self, sid: u64) -> Vec<FwdEv> {
        self.until(&format!("stream {sid} to end"), |got| got.iter().any(|m| matches!(m, ServerMsg::Fwd { sid: s, ev } if *s == sid && ev.is_final())))
            .await;
        self.events(sid)
    }
}

fn events_of(got: &[ServerMsg], sid: u64) -> Vec<FwdEv> {
    got.iter().filter_map(|m| match m { ServerMsg::Fwd { sid: s, ev } if *s == sid => Some(ev.clone()), _ => None }).collect()
}

fn output(evs: &[FwdEv], want_fd: u8) -> Vec<u8> {
    evs.iter().filter_map(|e| match e { FwdEv::Data { data, fd } if *fd == want_fd => Some(B64.decode(data).unwrap()), _ => None }).flatten().collect()
}

fn command(line: &str) -> FwdEv {
    FwdEv::Open { kind: ForwardKind::Command, name: "mac".into(), command: Some(line.into()), argv: None, pty: None, cwd: None, port: None }
}

fn data(bytes: &[u8]) -> FwdEv {
    FwdEv::Data { data: B64.encode(bytes), fd: 0 }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_runs_in_the_users_shell_with_its_output_and_exit_status() {
    let (fwd, _paths, _td) = forwarder();
    let c = client("c1");
    let mut inbox = Inbox::new(&c);
    fwd.fwd(&c, 1, command("printf out; printf err >&2; test -t 0 || printf ' no-tty'; exit 3"));
    let evs = inbox.ended(1).await;
    assert_eq!(evs.first(), Some(&FwdEv::Opened { pty: false }));
    assert_eq!(String::from_utf8(output(&evs, 1)).unwrap(), "out no-tty");
    assert_eq!(output(&evs, 2), b"err");
    assert_eq!(evs.last(), Some(&FwdEv::Exit { code: Some(3), signal: None }));
    assert!(fwd.lock().remote.is_empty(), "the stream is gone once it ended");
}

fn acked(evs: &[FwdEv]) -> u64 {
    evs.iter().map(|e| if let FwdEv::Ack { n } = e { *n } else { 0 }).sum()
}

/// stdin arrives intact (a payload larger than the window) and every byte is acknowledged once
/// the program took it; `eof` closes it.
#[tokio::test(flavor = "multi_thread")]
async fn stdin_is_piped_and_acknowledged() {
    let (fwd, _paths, _td) = forwarder();
    let c = client("c1");
    let mut inbox = Inbox::new(&c);
    fwd.fwd(&c, 3, command("cat"));
    let payload: Vec<u8> = (0..1_000_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let (mut sent, mut out_acked) = (0u64, 0u64);
    let mut chunks = payload.chunks(FWD_CHUNK).peekable();
    while chunks.peek().is_some() {
        inbox.until("progress", |_| true).await;
        // Acknowledge cat's output, as a caller does, so it keeps reading.
        let out = output(&inbox.events(3), 1).len() as u64;
        if out > out_acked {
            fwd.fwd(&c, 3, FwdEv::Ack { n: out - out_acked });
            out_acked = out;
        }
        // Stay within the window, as a sender must.
        while let Some(chunk) = chunks.peek()
            && sent - acked(&inbox.events(3)) + chunk.len() as u64 <= FWD_WINDOW
        {
            fwd.fwd(&c, 3, data(chunk));
            sent += chunk.len() as u64;
            chunks.next();
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    fwd.fwd(&c, 3, FwdEv::Eof);
    loop {
        inbox.until("cat's output", |_| true).await;
        let out = output(&inbox.events(3), 1).len() as u64;
        if out > out_acked {
            fwd.fwd(&c, 3, FwdEv::Ack { n: out - out_acked });
            out_acked = out;
        }
        if inbox.events(3).last().is_some_and(FwdEv::is_final) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let evs = inbox.events(3);
    assert_eq!(output(&evs, 1), payload, "cat echoes stdin byte for byte");
    assert_eq!(acked(&evs), payload.len() as u64);
    assert_eq!(evs.last(), Some(&FwdEv::Exit { code: Some(0), signal: None }));
}

/// A tool gets its arguments exactly as given: no shell sees them.
#[tokio::test(flavor = "multi_thread")]
async fn a_tool_gets_its_arguments_exactly() {
    let (fwd, _paths, _td) = forwarder();
    let c = client("c1");
    let mut inbox = Inbox::new(&c);
    let argv = ["printf", "%s|", "a b", "$HOME", "'q'"].map(String::from).to_vec();
    fwd.fwd(&c, 5, FwdEv::Open { kind: ForwardKind::Tool, name: "mac".into(), command: None, argv: Some(argv), pty: None, cwd: Some("/".into()), port: None });
    let evs = inbox.ended(5).await;
    assert_eq!(String::from_utf8(output(&evs, 1)).unwrap(), "a b|$HOME|'q'|");
    fwd.fwd(&c, 7, FwdEv::Open { kind: ForwardKind::Tool, name: "mac".into(), command: None, argv: Some(vec!["no-such-tool-xyz".into()]), pty: None, cwd: None, port: None });
    assert_eq!(inbox.ended(7).await, vec![FwdEv::Close { error: Some("no-such-tool-xyz: command not found".into()) }]);
    fwd.fwd(&c, 9, FwdEv::Open { kind: ForwardKind::Command, name: "mac".into(), command: Some("true".into()), argv: None, pty: None, cwd: Some("/no/such/dir".into()), port: None });
    assert_eq!(inbox.ended(9).await, vec![FwdEv::Close { error: Some("no such directory: /no/such/dir".into()) }]);
}

/// With a terminal: the program sees one of the requested size, and a resize reaches it.
#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_has_the_callers_size_and_follows_resizes() {
    let (fwd, _paths, _td) = forwarder();
    let c = client("c1");
    let mut inbox = Inbox::new(&c);
    let open = FwdEv::Open {
        kind: ForwardKind::Command,
        name: "mac".into(),
        command: Some("stty size; echo term=$TERM; read x; stty size".into()),
        argv: None,
        pty: Some(FwdPty { cols: 91, rows: 27, term: Some("xterm-test".into()) }),
        cwd: None,
        port: None,
    };
    fwd.fwd(&c, 11, open);
    inbox.until("the first size", |got| String::from_utf8_lossy(&output(&events_of(got, 11), 1)).contains("term=xterm-test")).await;
    assert_eq!(inbox.events(11).first(), Some(&FwdEv::Opened { pty: true }));
    fwd.fwd(&c, 11, FwdEv::Resize { cols: 100, rows: 40 });
    fwd.fwd(&c, 11, data(b"go\r"));
    let evs = inbox.ended(11).await;
    let text = String::from_utf8_lossy(&output(&evs, 1)).into_owned();
    assert!(text.contains("27 91") && text.contains("40 100"), "{text:?}");
    assert_eq!(evs.last(), Some(&FwdEv::Exit { code: Some(0), signal: None }));
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// A stream closed early (or an app that disconnects) kills everything the program started.
#[tokio::test(flavor = "multi_thread")]
async fn an_early_close_or_a_dropped_app_kills_the_process_group() {
    let (fwd, _paths, _td) = forwarder();
    for gone in [false, true] {
        let c = client(if gone { "c2" } else { "c1" });
        let mut inbox = Inbox::new(&c);
        fwd.fwd(&c, 13, command("sleep 300 & echo $!; wait"));
        inbox.until("the background pid", |got| got.iter().any(|m| matches!(m, ServerMsg::Fwd { ev: FwdEv::Data { .. }, .. }))).await;
        let pid: i32 = String::from_utf8(output(&inbox.events(13), 1)).unwrap().trim().parse().unwrap();
        assert!(alive(pid));
        if gone {
            fwd.client_gone(c.id());
        } else {
            fwd.fwd(&c, 13, FwdEv::Close { error: None });
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while alive(pid) {
            assert!(std::time::Instant::now() < deadline, "the background job outlived its stream");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(fwd.lock().remote.is_empty());
    }
}

/// A sender that ignores the window is cut off instead of growing the daemon's memory, by the
/// frame that takes what the program has not consumed past the window. `sleep` never reads its
/// stdin, but its pipe takes (and the daemon acknowledges) the first frames, so the sender keeps
/// sending until the stream is gone. Nothing of the stream follows its close.
#[tokio::test(flavor = "multi_thread")]
async fn data_past_the_window_ends_the_stream() {
    let (fwd, _paths, _td) = forwarder();
    let c = client("c1");
    let mut inbox = Inbox::new(&c);
    fwd.fwd(&c, 15, command("sleep 30"));
    let chunk = vec![b'x'; FWD_CHUNK];
    let key = (c.id().to_string(), 15);
    let mut sent = 0;
    while fwd.lock().remote.contains_key(&key) {
        assert!(sent < 4 * FWD_WINDOW, "{sent} bytes sent and the stream still runs");
        fwd.fwd(&c, 15, data(&chunk));
        sent += FWD_CHUNK as u64;
    }
    let evs = inbox.ended(15).await;
    assert!(matches!(evs.last(), Some(FwdEv::Close { error: Some(e) }) if e.contains("flow-control window")), "{evs:?}");
    // Cut off by the frame that passed the window: what was sent minus what the daemon had
    // acknowledged is over it, and was not one frame earlier (an acknowledgement counted just
    // before the cut may not have gone out).
    let acked = acked(&evs);
    assert!(sent > FWD_WINDOW + acked && sent <= FWD_WINDOW + acked + 2 * FWD_CHUNK as u64, "cut off after {sent} bytes with {acked} acknowledged");
}

/// A port stream connects to 127.0.0.1 and carries both directions until each ended.
#[tokio::test(flavor = "multi_thread")]
async fn a_port_stream_reaches_a_local_server() {
    let (fwd, _paths, _td) = forwarder();
    let c = client("c1");
    let mut inbox = Inbox::new(&c);
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = server.local_addr().unwrap().port();
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let (mut s, _) = server.accept().await.unwrap();
        let mut got = Vec::new();
        s.read_to_end(&mut got).await.unwrap();
        s.write_all(&got.to_ascii_uppercase()).await.unwrap();
    });
    fwd.fwd(&c, 17, FwdEv::Open { kind: ForwardKind::Port, name: "mac".into(), command: None, argv: None, pty: None, cwd: None, port: Some(port) });
    fwd.fwd(&c, 17, data(b"hello"));
    fwd.fwd(&c, 17, FwdEv::Eof);
    inbox.until("the reply and its end", |got| got.iter().any(|m| matches!(m, ServerMsg::Fwd { sid: 17, ev: FwdEv::Eof }))).await;
    let evs = inbox.events(17);
    assert_eq!(evs.first(), Some(&FwdEv::Opened { pty: false }));
    assert_eq!(output(&evs, 1), b"HELLO");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !fwd.lock().remote.is_empty() {
        assert!(std::time::Instant::now() < deadline, "both directions ended: the stream is over");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Nothing listens: the stream is refused with the reason.
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_port = dead.local_addr().unwrap().port();
    drop(dead);
    fwd.fwd(&c, 19, FwdEv::Open { kind: ForwardKind::Port, name: "mac".into(), command: None, argv: None, pty: None, cwd: None, port: Some(dead_port) });
    let evs = inbox.ended(19).await;
    assert!(matches!(&evs[..], [FwdEv::Close { error: Some(e) }] if e.starts_with(&format!("nothing accepts connections on 127.0.0.1:{dead_port}"))), "{evs:?}");
}

fn offer(name: &str, shell: bool, tools: &[&str], ports: &[(u16, u16)], ready: bool) -> FwdOffer {
    FwdOffer {
        name: name.into(),
        to: "Studio Mac".into(),
        shell,
        tools: tools.iter().map(|t| t.to_string()).collect(),
        ports: ports.iter().map(|(listen, target)| ForwardPort { listen: *listen, target: *target }).collect(),
        ready,
        reason: None,
    }
}

fn states(inbox: &Inbox) -> Option<Vec<FwdOfferState>> {
    inbox.got.iter().rev().find_map(|m| if let ServerMsg::FwdOffered { states } = m { Some(states.clone()) } else { None })
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// Offers become shims and port listeners; the newest app's offer of a name wins; what an app
/// offered goes with it.
#[tokio::test(flavor = "multi_thread")]
async fn offers_drive_shims_ports_and_the_winner() {
    let (fwd, paths, _td) = forwarder();
    let bin = paths.home.join("forward").join("bin");
    assert!(bin.join("tf-forward").is_file() && paths.home.join("bin").join("tf-forward").is_file(), "launchers written at start");
    let (c1, c2) = (client("c1"), client("c2"));
    let (mut in1, mut in2) = (Inbox::new(&c1), Inbox::new(&c2));
    // The busy port is held before the free one is picked: the kernel cannot hand out one port twice.
    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let (listen, busy_port) = (free_port(), busy.local_addr().unwrap().port());
    fwd.offer(&c1, vec![offer("mac", true, &["agent-browser"], &[(listen, 9222), (busy_port, 1)], true)]);
    in1.until("fwdOffered", |got| got.iter().any(|m| matches!(m, ServerMsg::FwdOffered { .. }))).await;
    let s = states(&in1).unwrap();
    assert!(s[0].active, "{s:?}");
    assert_eq!(s[0].port_errors, vec![ForwardPortError { listen: busy_port, message: format!("port {busy_port} is in use on this host") }]);
    assert!(std::fs::read_to_string(bin.join("agent-browser")).unwrap().contains("forward --tool 'agent-browser' 'mac'"));

    // A connection to the forwarded port opens a port stream towards the app.
    let mut conn = tokio::net::TcpStream::connect(("127.0.0.1", listen)).await.unwrap();
    in1.until("the port stream", |got| got.iter().any(|m| matches!(m, ServerMsg::Fwd { ev: FwdEv::Open { kind: ForwardKind::Port, .. }, .. }))).await;
    let (sid, port) = in1.got.iter().find_map(|m| match m { ServerMsg::Fwd { sid, ev: FwdEv::Open { port, .. } } => Some((*sid, *port)), _ => None }).unwrap();
    assert_eq!((sid % 2, port), (0, Some(listen)), "hostd opens even ids; the app maps the listen port");
    // The app connects it on the to-host and the bytes flow.
    fwd.fwd(&c1, sid, FwdEv::Opened { pty: false });
    conn.write_all(b"ping").await.unwrap();
    in1.until("the connection's bytes", |got| got.iter().any(|m| matches!(m, ServerMsg::Fwd { ev: FwdEv::Data { fd: 0, .. }, .. }))).await;
    assert_eq!(output(&in1.events(sid), 0), b"ping");
    fwd.fwd(&c1, sid, FwdEv::Data { data: B64.encode(b"pong"), fd: 1 });
    let mut buf = [0u8; 4];
    tokio::io::AsyncReadExt::read_exact(&mut conn, &mut buf).await.unwrap();
    assert_eq!(&buf, b"pong");

    // Another app offers the same name later: it wins; the first learns why it lost.
    fwd.offer(&c2, vec![offer("mac", false, &[], &[], true)]);
    in1.until("losing the name", |got| states_in(got).is_some_and(|s| !s[0].active)).await;
    assert_eq!(states(&in1).unwrap()[0].message.as_deref(), Some("TeleFlock on c2-device relays \"mac\" to this host"));
    in2.until("winning the name", |got| states_in(got).is_some_and(|s| s[0].active)).await;
    assert!(!bin.join("agent-browser").exists(), "the winner forwards no tools");
    port_closed(listen).await;

    // The winner disconnects: the first app's offer applies again.
    fwd.client_gone(c2.id());
    in1.until("the name back", |got| states_in(got).is_some_and(|s| s[0].active)).await;
    assert!(bin.join("agent-browser").exists());
    // Its last offer withdraws everything.
    fwd.offer(&c1, vec![]);
    assert!(!bin.join("agent-browser").exists() && bin.join("tf-forward").exists());
    port_closed(listen).await;
    // A malformed offer (a tool name that is a path) is ignored.
    fwd.offer(&c1, vec![offer("mac", true, &["../evil"], &[], true)]);
    assert!(fwd.lock().offers.winners().is_empty());
    drop(busy);
}

/// The listener of `port` is gone (it closes as its accept task ends, a moment after the offer).
async fn port_closed(port: u16) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
        assert!(std::time::Instant::now() < deadline, "port {port} still listens");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn states_in(got: &[ServerMsg]) -> Option<Vec<FwdOfferState>> {
    got.iter().rev().find_map(|m| if let ServerMsg::FwdOffered { states } = m { Some(states.clone()) } else { None })
}

async fn cli_open(paths: &Paths, open: FwdEv) -> (BufReader<BoxRead>, BoxWrite) {
    let (r, mut w) = endpoint::connect(paths).await.unwrap();
    assert!(write_line(&mut w, &CliRequest::Open { open }).await);
    (BufReader::new(r), w)
}

async fn cli_next(r: &mut BufReader<BoxRead>) -> Option<FwdEv> {
    let mut line = String::new();
    match tokio::time::timeout(Duration::from_secs(10), crate::clients::read_line(r, &mut line)).await.expect("a line from hostd") {
        Ok(true) => Some(serde_json::from_str(&line).unwrap()),
        _ => None,
    }
}

/// `tf-forward`'s endpoint: opens are checked against the winning offer and relayed to its app,
/// events pass through both ways, and either side going away ends the stream for the other.
#[tokio::test(flavor = "multi_thread")]
async fn the_endpoint_relays_tf_forward_to_the_app() {
    let (fwd, paths, _td) = forwarder();
    let c = client("c1");
    let mut inbox = Inbox::new(&c);
    let refused = |r: Option<FwdEv>| match r {
        Some(FwdEv::Close { error: Some(e) }) => e,
        other => panic!("expected a refusal, got {other:?}"),
    };

    // Nobody relays anything yet.
    let (mut r, _w) = cli_open(&paths, command("ls")).await;
    assert_eq!(refused(cli_next(&mut r).await), "no TeleFlock app is connected to relay to \"mac\"");
    fwd.offer(&c, vec![offer("mac", true, &[], &[], true), offer("tools-only", false, &["adb"], &[], true), offer("off", true, &[], &[], false)]);
    let (mut r, _w) = cli_open(&paths, command("ls").clone_named("nas")).await;
    assert_eq!(refused(cli_next(&mut r).await), "no forward called \"nas\" (tf-forward --list shows them)");
    let (mut r, _w) = cli_open(&paths, command("ls").clone_named("tools-only")).await;
    assert_eq!(refused(cli_next(&mut r).await), "forward \"tools-only\" runs no commands or shells, only its tools and ports");
    let (mut r, _w) = cli_open(&paths, command("ls").clone_named("off")).await;
    assert_eq!(refused(cli_next(&mut r).await), "Studio Mac is not connected to TeleFlock on c1-device");

    // A stream through to the app and back.
    let (mut r, mut w) = cli_open(&paths, command("echo hi")).await;
    inbox.until("the open", |got| got.iter().any(|m| matches!(m, ServerMsg::Fwd { ev: FwdEv::Open { .. }, .. }))).await;
    let sid = inbox.got.iter().find_map(|m| if let ServerMsg::Fwd { sid, ev: FwdEv::Open { command, .. } } = m { assert_eq!(command.as_deref(), Some("echo hi")); Some(*sid) } else { None }).unwrap();
    fwd.fwd(&c, sid, FwdEv::Opened { pty: false });
    fwd.fwd(&c, sid, FwdEv::Data { data: B64.encode(b"hi\n"), fd: 1 });
    assert_eq!(cli_next(&mut r).await, Some(FwdEv::Opened { pty: false }));
    assert_eq!(cli_next(&mut r).await, Some(FwdEv::Data { data: B64.encode(b"hi\n"), fd: 1 }));
    assert!(write_line(&mut w, &FwdEv::Ack { n: 3 }).await);
    assert!(write_line(&mut w, &FwdEv::Data { data: B64.encode(b"in"), fd: 2 }).await);
    inbox.until("the caller's events", |got| got.iter().any(|m| matches!(m, ServerMsg::Fwd { ev: FwdEv::Data { fd: 0, .. }, .. }))).await;
    let evs = inbox.events(sid);
    assert!(evs.contains(&FwdEv::Ack { n: 3 }) && evs.contains(&FwdEv::Data { data: B64.encode(b"in"), fd: 0 }), "{evs:?}");
    fwd.fwd(&c, sid, FwdEv::Exit { code: Some(0), signal: None });
    assert_eq!(cli_next(&mut r).await, Some(FwdEv::Exit { code: Some(0), signal: None }));
    assert_eq!(cli_next(&mut r).await, None, "the endpoint closes after the last event");

    // The app disconnects mid-stream: the caller learns why.
    let (mut r, _w) = cli_open(&paths, command("sleep 9")).await;
    inbox.until("the second open", |got| got.iter().filter(|m| matches!(m, ServerMsg::Fwd { ev: FwdEv::Open { .. }, .. })).count() == 2).await;
    fwd.client_gone(c.id());
    assert_eq!(refused(cli_next(&mut r).await), "the TeleFlock app relaying it disconnected (c1-device)");

    // The caller goes away mid-stream: the app learns it, so the to-host stops the program.
    let c = client("c3");
    let mut inbox = Inbox::new(&c);
    fwd.offer(&c, vec![offer("mac", true, &[], &[], true)]);
    let (r, w) = cli_open(&paths, command("sleep 9")).await;
    inbox.until("the open", |got| got.iter().any(|m| matches!(m, ServerMsg::Fwd { ev: FwdEv::Open { .. }, .. }))).await;
    let sid = inbox.got.iter().find_map(|m| if let ServerMsg::Fwd { sid, ev: FwdEv::Open { .. } } = m { Some(*sid) } else { None }).unwrap();
    drop((r, w));
    inbox.until("the close", |got| got.iter().any(|m| matches!(m, ServerMsg::Fwd { sid: s, ev: FwdEv::Close { error: None } } if *s == sid))).await;
    assert!(fwd.lock().local.is_empty());

    // `--list` shows what relays what, and names relayed before.
    let (lr, mut lw) = endpoint::connect(&paths).await.unwrap();
    assert!(write_line(&mut lw, &CliRequest::List).await);
    let mut lr = BufReader::new(lr);
    let mut line = String::new();
    assert!(crate::clients::read_line(&mut lr, &mut line).await.unwrap());
    let list: ListReply = serde_json::from_str(&line).unwrap();
    let names: Vec<(&str, bool)> = list.forwards.iter().map(|f| (f.name.as_str(), f.offer.is_some())).collect();
    assert_eq!(names, vec![("mac", true), ("off", false), ("tools-only", false)]);
    assert_eq!(list.forwards[0].device, "c3-device");
}

trait Named {
    fn clone_named(self, name: &str) -> FwdEv;
}

impl Named for FwdEv {
    fn clone_named(self, n: &str) -> FwdEv {
        match self {
            FwdEv::Open { kind, command, argv, pty, cwd, port, .. } => FwdEv::Open { kind, name: n.into(), command, argv, pty, cwd, port },
            other => other,
        }
    }
}

/// A program that exited but left a job writing to its output: a close (or a dropped app) still
/// ends the job, whose writes wait for credit nobody gives any more.
#[tokio::test(flavor = "multi_thread")]
async fn a_close_after_the_program_exited_still_kills_its_jobs() {
    let (fwd, _paths, _td) = forwarder();
    for gone in [false, true] {
        let c = client(if gone { "c2" } else { "c1" });
        let mut inbox = Inbox::new(&c);
        // The shell exits at once; its job keeps stdout busy (never pauses 200 ms).
        fwd.fwd(&c, 21, command("yes & echo $! >&2"));
        // No acks: the window (stdout and stderr share it) is spent, less than a frame of credit
        // left, and the output waits for credit.
        let sent = |got: &[ServerMsg]| (output(&events_of(got, 21), 1).len() + output(&events_of(got, 21), 2).len()) as u64;
        inbox.until("a spent window", |got| sent(got) > FWD_WINDOW - FWD_CHUNK as u64).await;
        let pid: i32 = String::from_utf8(output(&inbox.events(21), 2)).unwrap().trim().parse().unwrap();
        if gone {
            fwd.client_gone(c.id());
        } else {
            fwd.fwd(&c, 21, FwdEv::Close { error: None });
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while alive(pid) {
            assert!(std::time::Instant::now() < deadline, "the job outlived its closed stream");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// A caller that acknowledges bytes it never got, or sends past its window, is cut off: the lie
/// never reaches the app (it would open the to-host's window), the app learns why.
#[tokio::test(flavor = "multi_thread")]
async fn a_caller_breaking_the_flow_control_is_cut_off() {
    let (fwd, paths, _td) = forwarder();
    let c = client("c1");
    let mut inbox = Inbox::new(&c);
    fwd.offer(&c, vec![offer("mac", true, &[], &[], true)]);
    let opened = |got: &[ServerMsg]| got.iter().filter_map(|m| if let ServerMsg::Fwd { sid, ev: FwdEv::Open { .. } } = m { Some(*sid) } else { None }).collect::<Vec<_>>();
    // Acknowledging more than it received.
    let (_r, mut w) = cli_open(&paths, command("yes")).await;
    inbox.until("the open", |got| opened(got).len() == 1).await;
    let sid = opened(&inbox.got)[0];
    fwd.fwd(&c, sid, FwdEv::Opened { pty: false });
    fwd.fwd(&c, sid, FwdEv::Data { data: B64.encode(b"y\n"), fd: 1 });
    assert!(write_line(&mut w, &FwdEv::Ack { n: FWD_WINDOW }).await);
    inbox.until("the cut", |got| events_of(got, sid).iter().any(|e| matches!(e, FwdEv::Close { error: Some(_) }))).await;
    assert!(!inbox.events(sid).contains(&FwdEv::Ack { n: FWD_WINDOW }), "the lie never reaches the app");
    // Sending past its window (no acks come back).
    let (_r2, mut w2) = cli_open(&paths, command("cat")).await;
    inbox.until("the second open", |got| opened(got).len() == 2).await;
    let sid2 = opened(&inbox.got)[1];
    fwd.fwd(&c, sid2, FwdEv::Opened { pty: false });
    let chunk = data(&vec![b'x'; FWD_CHUNK]);
    for _ in 0..=(FWD_WINDOW as usize / FWD_CHUNK) {
        if !write_line(&mut w2, &chunk).await {
            break;
        }
    }
    let evs = inbox.ended(sid2).await;
    assert!(matches!(evs.last(), Some(FwdEv::Close { error: Some(e) }) if e.contains("flow-control window")), "{evs:?}");
    assert!(output(&evs, 0).len() as u64 <= FWD_WINDOW, "at most a window reached the app");
}

/// A port's server listening on [::1] only (a dev server on `localhost` on macOS) is reached too:
/// 127.0.0.1 refuses, [::1] answers.
#[tokio::test(flavor = "multi_thread")]
async fn a_port_stream_reaches_a_server_on_ipv6_loopback() {
    let Ok(server) = tokio::net::TcpListener::bind("[::1]:0").await else { return }; // no IPv6 here
    let port = server.local_addr().unwrap().port();
    if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
        return; // the port is taken on 127.0.0.1: nothing to fall back from
    }
    let (fwd, _paths, _td) = forwarder();
    let c = client("c1");
    let mut inbox = Inbox::new(&c);
    tokio::spawn(async move {
        let (mut s, _) = server.accept().await.unwrap();
        s.write_all(b"from ::1").await.unwrap();
    });
    fwd.fwd(&c, 23, FwdEv::Open { kind: ForwardKind::Port, name: "mac".into(), command: None, argv: None, pty: None, cwd: None, port: Some(port) });
    inbox.until("the server's bytes", |got| output(&events_of(got, 23), 1) == b"from ::1").await;
    assert_eq!(inbox.events(23).first(), Some(&FwdEv::Opened { pty: false }));
}

/// A stopping daemon takes its shims and listeners with it (a stale shim would shadow the real
/// tool), also those of tools whose names start with a dot, and offers made afterwards change
/// nothing.
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_removes_the_shims_and_listeners() {
    let (fwd, paths, _td) = forwarder();
    let bin = paths.home.join("forward").join("bin");
    let c = client("c1");
    let listen = free_port();
    fwd.offer(&c, vec![offer("mac", true, &["agent-browser", ".dot"], &[(listen, 1)], true)]);
    assert!(bin.join("agent-browser").is_file() && bin.join(".dot").is_file());
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", listen)).await.is_ok());
    fwd.offer(&c, vec![offer("mac", true, &["agent-browser"], &[(listen, 1)], true)]);
    assert!(!bin.join(".dot").exists(), "a dot tool's shim goes like any other");
    fwd.shutdown().await;
    assert!(!bin.join("agent-browser").exists() && bin.join("tf-forward").exists());
    port_closed(listen).await;
    fwd.offer(&c, vec![offer("mac", true, &["agent-browser"], &[], true)]);
    assert!(!bin.join("agent-browser").exists(), "nothing is written after shutdown");
}
