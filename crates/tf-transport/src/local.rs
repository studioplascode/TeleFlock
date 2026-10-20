//! Local transport: `tokio::process` without a shell (herdr on this Windows machine).

use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot, watch};

use crate::{BoxedStream, Child, Cmd, ExitStatus, HostKind, Output, Transport, TransportError, TransportEvent};

/// `CREATE_NO_WINDOW`: never flash a console window for child processes on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Runs commands directly on this machine. Also the process layer under [`crate::WslTransport`].
pub struct LocalTransport {
    kind: HostKind,
    events: mpsc::Sender<TransportEvent>,
    /// `true` once closed; spawned children watch it and are killed on close.
    closed: watch::Sender<bool>,
}

impl LocalTransport {
    pub fn new(events: mpsc::Sender<TransportEvent>) -> Self {
        Self::with_kind(HostKind::Local, events)
    }

    pub(crate) fn with_kind(kind: HostKind, events: mpsc::Sender<TransportEvent>) -> Self {
        Self { kind, events, closed: watch::Sender::new(false) }
    }

    fn ensure_open(&self) -> Result<(), TransportError> {
        if *self.closed.borrow() { Err(TransportError::Closed(None)) } else { Ok(()) }
    }

    pub(crate) fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Mark closed (kills spawned children). Returns false if it was already closed.
    pub(crate) fn mark_closed(&self) -> bool {
        !self.closed.send_replace(true)
    }

    pub(crate) async fn emit_closed(&self) {
        let _ = self.events.send(TransportEvent::Closed(None)).await;
    }
}

/// Build a `tokio::process::Command` for argv with piped stdio and no console window.
pub(crate) fn command(cmd: &Cmd) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(&cmd.argv[0]);
    c.args(&cmd.argv[1..]);
    for (k, v) in &cmd.env {
        c.env(k, v);
    }
    if let Some(dir) = cmd.cwd.as_deref().filter(|d| !d.is_empty()) {
        c.current_dir(dir);
    }
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

fn spawn_err(program: &str, e: std::io::Error) -> TransportError {
    TransportError::Spawn { program: program.to_owned(), detail: e.to_string() }
}

pub(crate) fn exit_status(s: std::process::ExitStatus) -> ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = s.signal() {
            return ExitStatus { code: None, signal: Some(signal_name(sig)) };
        }
    }
    ExitStatus { code: s.code(), signal: None }
}

#[cfg(unix)]
fn signal_name(sig: i32) -> String {
    match sig {
        1 => "HUP",
        2 => "INT",
        3 => "QUIT",
        6 => "ABRT",
        9 => "KILL",
        13 => "PIPE",
        15 => "TERM",
        _ => return sig.to_string(),
    }
    .into()
}

/// Run argv locally to completion.
pub(crate) async fn run(cmd: &Cmd) -> Result<Output, TransportError> {
    cmd.check()?;
    let mut child = command(cmd).spawn().map_err(|e| spawn_err(&cmd.argv[0], e))?;
    let mut stdin = child.stdin.take();
    let input = cmd.stdin.clone();
    let writer = async move {
        if let (Some(w), Some(data)) = (stdin.as_mut(), input) {
            // A process that exits without reading stdin gives BrokenPipe; that's its choice.
            let _ = w.write_all(&data).await;
            let _ = w.shutdown().await;
        }
        drop(stdin);
    };
    let run = async {
        let ((), out) = tokio::join!(writer, child.wait_with_output());
        let out = out.map_err(TransportError::io)?;
        Ok(Output { status: exit_status(out.status), stdout: out.stdout, stderr: out.stderr })
    };
    match cmd.timeout {
        // On timeout the future (and the child, kill_on_drop) is dropped → killed.
        Some(t) => tokio::time::timeout(t, run)
            .await
            .map_err(|_| TransportError::Timeout { what: format!("`{}`", cmd.argv[0]), secs: t.as_secs() })?,
        None => run.await,
    }
}

/// Start argv locally; the child is killed when the `Child` is dropped/killed or `closed` flips.
pub(crate) fn start(cmd: &Cmd, mut closed: watch::Receiver<bool>) -> Result<Child, TransportError> {
    cmd.check()?;
    let mut child = command(cmd).spawn().map_err(|e| spawn_err(&cmd.argv[0], e))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (exit_tx, exit_rx) = oneshot::channel();
    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let res = tokio::select! {
            r = child.wait() => r.map(exit_status).map_err(TransportError::io),
            // Fires on explicit kill and when the Child handle is dropped.
            _ = &mut kill_rx => {
                let _ = child.kill().await;
                child.wait().await.map(exit_status).map_err(TransportError::io)
            }
            _ = async { let _ = closed.wait_for(|c| *c).await; } => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err(TransportError::Closed(None))
            }
        };
        let _ = exit_tx.send(res);
    });
    Ok(Child::new(Box::new(stdin), Box::new(stdout), Box::new(stderr), exit_rx, kill_tx))
}

pub(crate) async fn tcp(host: &str, port: u16) -> Result<BoxedStream, TransportError> {
    let s = tokio::net::TcpStream::connect((host, port)).await.map_err(|e| TransportError::Connect {
        addr: format!("{host}:{port}"),
        detail: e.to_string(),
        hint: Some("Is the service listening on that port?".into()),
    })?;
    let _ = s.set_nodelay(true);
    Ok(Box::new(s))
}

#[async_trait::async_trait]
impl Transport for LocalTransport {
    async fn exec(&self, cmd: &Cmd) -> Result<Output, TransportError> {
        self.ensure_open()?;
        run(cmd).await
    }

    async fn spawn(&self, cmd: &Cmd) -> Result<Child, TransportError> {
        self.ensure_open()?;
        start(cmd, self.closed.subscribe())
    }

    async fn forward_tcp(&self, host: &str, port: u16) -> Result<BoxedStream, TransportError> {
        self.ensure_open()?;
        tcp(host, port).await
    }

    fn kind(&self) -> HostKind {
        self.kind
    }

    async fn close(&self) {
        if self.mark_closed() {
            self.emit_closed().await;
        }
    }
}
