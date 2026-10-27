//! Local client endpoint: a unix socket (0600) or a Windows named pipe.

use std::io;
use std::pin::Pin;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::paths::Paths;

pub type BoxRead = Pin<Box<dyn AsyncRead + Send>>;
pub type BoxWrite = Pin<Box<dyn AsyncWrite + Send>>;

/// The client endpoint, bound before the async runtime exists: `daemon::run` binds it right
/// after taking the instance lock, so `attach` connects while the daemon still starts (the
/// connection waits in the backlog until the accept loop runs). Windows creates its pipe in
/// [`Listener::start`] instead: named pipes need the runtime.
pub struct Bound {
    #[cfg(unix)]
    socket: std::os::unix::net::UnixListener,
}

impl Bound {
    /// Binds the client socket (unix). The caller must hold the instance lock (a leftover
    /// socket file is stale and gets removed).
    pub fn bind(paths: &Paths) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::remove_file(&paths.sock);
            let socket = std::os::unix::net::UnixListener::bind(&paths.sock)?;
            std::fs::set_permissions(&paths.sock, std::fs::Permissions::from_mode(0o600))?;
            socket.set_nonblocking(true)?;
            Ok(Self { socket })
        }
        #[cfg(windows)]
        {
            let _ = paths;
            Ok(Self {})
        }
    }
}

#[cfg(unix)]
pub struct Listener {
    inner: tokio::net::UnixListener,
}

#[cfg(unix)]
impl Listener {
    /// Serves a [`Bound`] endpoint; call inside the runtime.
    pub fn start(bound: Bound, _paths: &Paths) -> io::Result<Self> {
        Ok(Self { inner: tokio::net::UnixListener::from_std(bound.socket)? })
    }

    pub async fn accept(&mut self) -> io::Result<(BoxRead, BoxWrite)> {
        let (stream, _) = self.inner.accept().await?;
        let (r, w) = stream.into_split();
        Ok((Box::pin(r), Box::pin(w)))
    }
}

#[cfg(unix)]
pub async fn connect(paths: &Paths) -> io::Result<(BoxRead, BoxWrite)> {
    let stream = tokio::net::UnixStream::connect(&paths.sock).await?;
    let (r, w) = stream.into_split();
    Ok((Box::pin(r), Box::pin(w)))
}

#[cfg(windows)]
pub struct Listener {
    name: String,
    /// Owner-only descriptor applied to every instance (kept alive across instances).
    sd: crate::secure::PrivateSd,
    next: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(windows)]
impl Listener {
    /// Creates the first pipe instance (fails if another process, possibly another user, already
    /// owns the name). DACL: current user + SYSTEM; remote clients rejected.
    pub fn start(_bound: Bound, paths: &Paths) -> io::Result<Self> {
        use tokio::net::windows::named_pipe::ServerOptions;
        let sd = crate::secure::PrivateSd::new()?;
        let next = crate::secure::create_pipe_server(
            ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true),
            &paths.pipe,
            &sd,
        )?;
        Ok(Self { name: paths.pipe.clone(), sd, next })
    }

    pub async fn accept(&mut self) -> io::Result<(BoxRead, BoxWrite)> {
        use tokio::net::windows::named_pipe::ServerOptions;
        self.next.connect().await?;
        let fresh = crate::secure::create_pipe_server(ServerOptions::new().reject_remote_clients(true), &self.name, &self.sd)?;
        let connected = std::mem::replace(&mut self.next, fresh);
        let (r, w) = tokio::io::split(connected);
        Ok((Box::pin(r), Box::pin(w)))
    }
}

/// Connects to the daemon pipe. Fails with `PermissionDenied` when the pipe's server process runs
/// as another user (a squatted pipe name).
#[cfg(windows)]
pub async fn connect(paths: &Paths) -> io::Result<(BoxRead, BoxWrite)> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match ClientOptions::new().open(&paths.pipe) {
            Ok(client) => {
                crate::secure::verify_pipe_server(&client)?;
                let (r, w) = tokio::io::split(client);
                return Ok((Box::pin(r), Box::pin(w)));
            }
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && std::time::Instant::now() < deadline => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) => return Err(e),
        }
    }
}
