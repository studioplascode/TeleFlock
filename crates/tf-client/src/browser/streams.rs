//! Agents' DevTools connections. tf-hostd streams every connection to an attached agent's
//! browser port to this app (`fwd`, kind `browser`, even stream ids: hostd opens them, `name` is
//! the agent's id); each is served by the DevTools proxy (`proxy::CdpProxy::serve`) over an
//! in-memory pipe. Flow control is that of every forwarding stream (`tf_proto::forward`): at
//! most `FWD_WINDOW` unacknowledged bytes each way, data frames of at most `FWD_CHUNK` bytes;
//! what this app received is acknowledged once the proxy took it. A stream ends when both
//! directions ended (`eof` each way), on `close`, with its link, or when the proxy is done with
//! it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use tf_proto::{FWD_CHUNK, FWD_WINDOW, FwdEv};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, mpsc, watch};

use super::proxy::{AttachKey, CdpProxy};
use crate::link::Link;

/// Bytes the pipe to the proxy buffers each way.
const PIPE: usize = 64 * 1024;

/// What arrived from the agent's side.
pub(super) enum In {
    Data(Vec<u8>),
    Eof,
}

/// This app's credit for sending towards the agent: what tf-hostd has not acknowledged yet.
#[derive(Default)]
pub(super) struct Credit {
    st: Mutex<(u64, bool)>,
    wake: Notify,
}

impl Credit {
    fn new() -> Credit {
        Credit { st: Mutex::new((FWD_WINDOW, false)), wake: Notify::new() }
    }

    /// Waits for room and takes up to a frame of it; `None` once the stream is over.
    async fn reserve(&self) -> Option<usize> {
        loop {
            {
                let mut st = self.st.lock().unwrap();
                if st.1 {
                    return None;
                }
                if st.0 > 0 {
                    let n = st.0.min(FWD_CHUNK as u64);
                    st.0 -= n;
                    return Some(n as usize);
                }
            }
            self.wake.notified().await;
        }
    }

    fn release(&self, n: usize) {
        self.st.lock().unwrap().0 += n as u64;
    }

    /// tf-hostd consumed `n` more bytes; `false` when that is more than it was sent.
    fn ack(&self, n: u64) -> bool {
        let mut st = self.st.lock().unwrap();
        if st.0 + n > FWD_WINDOW {
            return false;
        }
        st.0 += n;
        drop(st);
        self.wake.notify_one();
        true
    }

    fn close(&self) {
        self.st.lock().unwrap().1 = true;
        self.wake.notify_one();
    }
}

/// A stream's end the link reader feeds (`on_event`).
pub(super) struct Stream {
    pub who: AttachKey,
    inbound: mpsc::UnboundedSender<In>,
    credit: Arc<Credit>,
    /// Bytes received and not acknowledged yet.
    unacked: Arc<AtomicU64>,
    over: watch::Sender<bool>,
}

/// What [`Stream::on_event`] says about the stream.
pub(super) enum Fed {
    Ok,
    /// The stream is over (the peer closed it).
    Closed,
    /// The peer broke the protocol: close the stream with this error.
    Broken(&'static str),
}

impl Stream {
    /// An event from tf-hostd for this stream (in order, from the link's reader).
    pub fn on_event(&self, ev: FwdEv) -> Fed {
        match ev {
            FwdEv::Data { data, .. } => {
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()) else { return Fed::Broken("the host sent data that is not base64") };
                if bytes.len() > FWD_CHUNK {
                    return Fed::Broken("the host sent a data frame larger than 32 KiB");
                }
                if self.unacked.fetch_add(bytes.len() as u64, Ordering::SeqCst) + bytes.len() as u64 > FWD_WINDOW {
                    return Fed::Broken("the host sent more than the flow-control window allows");
                }
                let _ = self.inbound.send(In::Data(bytes));
                Fed::Ok
            }
            FwdEv::Eof => {
                let _ = self.inbound.send(In::Eof);
                Fed::Ok
            }
            FwdEv::Ack { n } if !self.credit.ack(n) => Fed::Broken("the host acknowledged more than it received"),
            FwdEv::Close { .. } | FwdEv::Exit { .. } => {
                self.end();
                Fed::Closed
            }
            _ => Fed::Ok,
        }
    }

    /// Ends the stream here: both directions stop, the pipe to the proxy closes.
    pub fn end(&self) {
        self.credit.close();
        let _ = self.over.send(true);
    }
}

/// A stream's runner: started with [`new`], run with [`Runner::run`] once the browser is up.
pub(super) struct Runner {
    inbound: mpsc::UnboundedReceiver<In>,
    credit: Arc<Credit>,
    unacked: Arc<AtomicU64>,
    over: watch::Receiver<bool>,
}

pub(super) fn new(who: AttachKey) -> (Stream, Runner) {
    let (tx, rx) = mpsc::unbounded_channel();
    let credit = Arc::new(Credit::new());
    let unacked = Arc::new(AtomicU64::new(0));
    let (over_tx, over_rx) = watch::channel(false);
    (
        Stream { who, inbound: tx, credit: credit.clone(), unacked: unacked.clone(), over: over_tx },
        Runner { inbound: rx, credit, unacked, over: over_rx },
    )
}

impl Runner {
    /// Serves stream `sid` of `link` with `proxy` until it ends: `opened` goes out first.
    pub async fn run(self, proxy: Arc<CdpProxy>, who: AttachKey, link: Arc<Link>, sid: u64) {
        let Runner { mut inbound, credit, unacked, mut over } = self;
        let (ours, theirs) = tokio::io::duplex(PIPE);
        let serving = {
            let proxy = proxy.clone();
            tokio::spawn(async move { proxy.serve(theirs, who).await })
        };
        let (mut rd, mut wr) = tokio::io::split(ours);
        if link.fwd(sid, FwdEv::Opened { pty: false }).is_err() {
            return;
        }
        // The proxy's bytes towards the agent, within the credit tf-hostd gives.
        let out = async {
            let mut buf = vec![0u8; FWD_CHUNK];
            while let Some(room) = credit.reserve().await {
                match rd.read(&mut buf[..room]).await {
                    Ok(n) if n > 0 => {
                        credit.release(room - n);
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        if link.fwd(sid, FwdEv::Data { data, fd: 1 }).is_err() {
                            return;
                        }
                    }
                    _ => {
                        let _ = link.fwd(sid, FwdEv::Eof);
                        return;
                    }
                }
            }
        };
        // The agent's bytes towards the proxy, acknowledged once it took them. `false`: the
        // proxy stopped reading (it is done with the connection).
        let inp = async {
            while let Some(m) = inbound.recv().await {
                match m {
                    In::Data(b) => {
                        if wr.write_all(&b).await.is_err() {
                            return false;
                        }
                        let n = b.len() as u64;
                        unacked.fetch_sub(n, Ordering::SeqCst);
                        if link.fwd(sid, FwdEv::Ack { n }).is_err() {
                            return true;
                        }
                    }
                    In::Eof => {
                        let _ = wr.shutdown().await;
                        return true;
                    }
                }
            }
            true
        };
        let both = async {
            let ((), read_on) = tokio::join!(out, inp);
            read_on
        };
        tokio::select! {
            read_on = both => {
                // The proxy closed the connection while the agent still sends: tf-hostd ends it.
                if !read_on {
                    let _ = link.fwd(sid, FwdEv::Close { error: None });
                }
            }
            _ = over.wait_for(|o| *o) => {}
            _ = link.closed() => {}
        }
        // Dropping the pipe ends the proxy's side; it finishes by itself.
        drop((rd, wr));
        let _ = serving.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn credit() {
        let c = Credit::new();
        let mut taken = 0;
        while taken < FWD_WINDOW {
            taken += c.reserve().await.unwrap() as u64;
        }
        assert_eq!(taken, FWD_WINDOW);
        assert!(!c.ack(FWD_WINDOW + 1), "more than was sent");
        assert!(c.ack(10));
        assert_eq!(c.reserve().await, Some(10));
        c.release(4);
        assert_eq!(c.reserve().await, Some(4));
        let waiting = tokio::spawn({
            let c = Arc::new(c);
            let c2 = c.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                c2.close();
            });
            async move { c.reserve().await }
        });
        assert_eq!(waiting.await.unwrap(), None, "a closed stream ends the wait");
    }

    #[test]
    fn flow_checks() {
        let (s, mut r) = new(AttachKey { host_id: "h".into(), agent_id: "a".into() });
        let frame = |n: usize| FwdEv::Data { data: base64::engine::general_purpose::STANDARD.encode(vec![7u8; n]), fd: 0 };
        for _ in 0..(FWD_WINDOW as usize / FWD_CHUNK) {
            assert!(matches!(s.on_event(frame(FWD_CHUNK)), Fed::Ok));
        }
        assert!(matches!(s.on_event(frame(1)), Fed::Broken(m) if m.contains("window")), "past the window without acks");
        let (s, _r2) = new(AttachKey { host_id: "h".into(), agent_id: "a".into() });
        assert!(matches!(s.on_event(FwdEv::Data { data: "%%".into(), fd: 0 }), Fed::Broken(_)));
        assert!(matches!(s.on_event(FwdEv::Ack { n: 1 }), Fed::Broken(m) if m.contains("acknowledged")));
        assert!(matches!(s.on_event(FwdEv::Close { error: None }), Fed::Closed));
        assert!(*s.over.borrow());
        assert!(matches!(r.inbound.try_recv(), Ok(In::Data(_))));
    }
}
