//! Local client endpoint: a unix socket (0600) or a Windows named pipe.

use std::io;
use std::pin::Pin;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::paths::Paths;

pub type BoxRead = Pin<Box<dyn AsyncRead + Send>>;
pub type BoxWrite = Pin<Box<dyn AsyncWrite + Send>>;

#[cfg(unix)]
pub struct Listener {
    inner: tokio::net::UnixListener,
}

#[cfg(unix)]
impl Listener {
    /// Binds the client socket. The caller must hold the instance lock (a leftover
    /// socket file is stale and gets removed).
    pub fn bind(paths: &Paths) -> io::Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::remove_file(&paths.sock);
        let inner = tokio::net::UnixListener::bind(&paths.sock)?;
        std::fs::set_permissions(&paths.sock, std::fs::Permissions::from_mode(0o600))?;
        Ok(Self { inner })
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
    next: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(windows)]
impl Listener {
    pub fn bind(paths: &Paths) -> io::Result<Self> {
        use tokio::net::windows::named_pipe::ServerOptions;
        let next = ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(&paths.pipe)?;
        Ok(Self { name: paths.pipe.clone(), next })
    }

    pub async fn accept(&mut self) -> io::Result<(BoxRead, BoxWrite)> {
        use tokio::net::windows::named_pipe::ServerOptions;
        self.next.connect().await?;
        let fresh = ServerOptions::new().reject_remote_clients(true).create(&self.name)?;
        let connected = std::mem::replace(&mut self.next, fresh);
        let (r, w) = tokio::io::split(connected);
        Ok((Box::pin(r), Box::pin(w)))
    }
}

#[cfg(windows)]
pub async fn connect(paths: &Paths) -> io::Result<(BoxRead, BoxWrite)> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match ClientOptions::new().open(&paths.pipe) {
            Ok(client) => {
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
