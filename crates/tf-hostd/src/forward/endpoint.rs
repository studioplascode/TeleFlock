//! The local endpoint `tf-forward` connects to: a unix socket (0600) in its own 0700 directory
//! under `<home>/run`, or a named pipe only the user (and SYSTEM) may open (`ipc.rs`' pattern).

use std::io;

use crate::ipc::{BoxRead, BoxWrite};
use crate::paths::Paths;

#[cfg(unix)]
pub(crate) struct Endpoint {
    inner: tokio::net::UnixListener,
}

#[cfg(unix)]
impl Endpoint {
    /// Binds the socket (the daemon holds the instance lock: a leftover socket is stale).
    pub fn bind(paths: &Paths) -> io::Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        if let Some(dir) = paths.forward_sock.parent() {
            crate::paths::create_private_dir(dir)?;
        }
        let _ = std::fs::remove_file(&paths.forward_sock);
        let inner = tokio::net::UnixListener::bind(&paths.forward_sock)?;
        std::fs::set_permissions(&paths.forward_sock, std::fs::Permissions::from_mode(0o600))?;
        Ok(Self { inner })
    }

    pub async fn accept(&mut self) -> io::Result<(BoxRead, BoxWrite)> {
        let (stream, _) = self.inner.accept().await?;
        let (r, w) = stream.into_split();
        Ok((Box::pin(r), Box::pin(w)))
    }
}

#[cfg(unix)]
pub(crate) async fn connect(paths: &Paths) -> io::Result<(BoxRead, BoxWrite)> {
    let stream = tokio::net::UnixStream::connect(&paths.forward_sock).await?;
    let (r, w) = stream.into_split();
    Ok((Box::pin(r), Box::pin(w)))
}

#[cfg(windows)]
pub(crate) struct Endpoint {
    name: String,
    sd: crate::secure::PrivateSd,
    next: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(windows)]
impl Endpoint {
    /// Creates the first pipe instance (fails if another process owns the name).
    pub fn bind(paths: &Paths) -> io::Result<Self> {
        use tokio::net::windows::named_pipe::ServerOptions;
        let sd = crate::secure::PrivateSd::new()?;
        let next = crate::secure::create_pipe_server(
            ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true),
            &paths.forward_pipe,
            &sd,
        )?;
        Ok(Self { name: paths.forward_pipe.clone(), sd, next })
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

/// Connects to the pipe; `PermissionDenied` when another user's process serves the name.
#[cfg(windows)]
pub(crate) async fn connect(paths: &Paths) -> io::Result<(BoxRead, BoxWrite)> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match ClientOptions::new().open(&paths.forward_pipe) {
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_socket_is_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let td = tempfile::tempdir().unwrap();
        let paths = Paths::new(td.path().to_path_buf(), true);
        std::fs::create_dir_all(&paths.run).unwrap();
        let mut ep = Endpoint::bind(&paths).unwrap();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&paths.forward_sock), 0o600);
        assert_eq!(mode(paths.forward_sock.parent().unwrap()), 0o700);
        let (accepted, connected) = tokio::join!(ep.accept(), connect(&paths));
        assert!(accepted.is_ok() && connected.is_ok());
        // A stale socket from a previous daemon is replaced.
        drop(ep);
        assert!(Endpoint::bind(&paths).is_ok());
    }
}
