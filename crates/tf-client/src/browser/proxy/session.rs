//! One agent WebSocket: its own WebSocket to the browser (the browser target, or one of its
//! pages), with every message in both directions through the connection's [`Filter`]. Writes go
//! through bounded queues so a slow reader on one side never stops the other side being read.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};

use super::filter::{Filter, Out, Root};
use super::{AttachKey, CdpProxy, monitor, ws_config};
use crate::util::now_ms;

/// Messages queued towards either side before reading the other side waits.
const QUEUE: usize = 256;
/// How long a new connection waits for the monitor's first report of the browser's targets.
const SYNC_WAIT: Duration = Duration::from_secs(5);

fn close_frame(reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code: CloseCode::Normal, reason: reason.to_string().into() }))
}

/// The text of a data message (CDP is JSON text; binary frames are taken as UTF-8).
fn text_of(m: Message) -> Result<Option<String>, ()> {
    match m {
        Message::Text(t) => Ok(Some(t.as_str().to_string())),
        Message::Binary(b) => String::from_utf8(b.to_vec()).map(Some).map_err(|_| ()),
        Message::Close(_) => Err(()),
        _ => Ok(None),
    }
}

/// Serves the agent's WebSocket (its handshake answered; `leftover`: bytes after the request
/// head) until either side closes or `stop` carries a reason.
pub(super) async fn run<IO>(
    px: Arc<CdpProxy>,
    io: IO,
    leftover: Vec<u8>,
    who: AttachKey,
    root: Root,
    conn: u64,
    mut stop: watch::Receiver<Option<String>>,
) where
    IO: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut agent = WebSocketStream::from_partially_read(io, leftover, Role::Server, Some(ws_config())).await;
    px.wait_synced(SYNC_WAIT).await;
    if root == Root::Browser {
        px.first_tab(&who).await;
    }
    let url = match &root {
        Root::Browser => px.browser_ws_url().await,
        Root::Page(p) => Ok(format!("ws://127.0.0.1:{}/devtools/page/{p}", px.port())),
    };
    let upstream = match url {
        Ok(u) => monitor::connect(&u).await,
        Err(e) => Err(e),
    };
    let upstream = match upstream {
        Ok(u) => u,
        Err(e) => {
            log::warn!("browser proxy: cannot reach the browser for {}/{}: {e}", who.host_id, who.agent_id);
            let _ = agent.send(close_frame("the browser is not reachable")).await;
            return;
        }
    };
    let (mut agent_tx, mut agent_rx) = agent.split();
    let (mut up_tx, mut up_rx) = upstream.split();
    let (to_agent, mut agent_q) = mpsc::channel::<Message>(QUEUE);
    let (to_up, mut up_q) = mpsc::channel::<Message>(QUEUE);
    let agent_writer = tokio::spawn(async move {
        while let Some(m) = agent_q.recv().await {
            let last = matches!(m, Message::Close(_));
            if agent_tx.send(m).await.is_err() || last {
                break;
            }
        }
        let _ = agent_tx.close().await;
    });
    let up_writer = tokio::spawn(async move {
        while let Some(m) = up_q.recv().await {
            if up_tx.send(m).await.is_err() {
                break;
            }
        }
        let _ = up_tx.close().await;
    });

    let mut filter = Filter::new(who.clone(), conn, root);
    let mut changes = px.internal_changes();
    let mut outs = filter.start();
    let mut closing: Option<String> = None;
    loop {
        for o in outs.drain(..) {
            let sent = match o {
                Out::Agent(s) => to_agent.send(Message::text(s)).await.is_ok(),
                Out::Browser(s) => to_up.send(Message::text(s)).await.is_ok(),
                Out::Close(reason) => {
                    closing = Some(reason);
                    false
                }
            };
            if !sent {
                break;
            }
        }
        if closing.is_none() {
            closing = stop.borrow().clone();
        }
        if closing.is_some() || to_agent.is_closed() || to_up.is_closed() {
            break;
        }
        let deadline = filter.deadline();
        let hold = async {
            match deadline {
                Some(d) => tokio::time::sleep_until(d.into()).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            m = agent_rx.next() => match m.map(|r| r.map_err(drop).and_then(text_of)) {
                Some(Ok(Some(t))) => outs = px.with_reg(|reg| filter.on_agent(reg, &t, now_ms())),
                Some(Ok(None)) => {}
                _ => break,
            },
            m = up_rx.next() => match m.map(|r| r.map_err(drop).and_then(text_of)) {
                Some(Ok(Some(t))) => outs = px.with_reg(|reg| filter.on_browser(reg, &t, Instant::now())),
                Some(Ok(None)) => {}
                _ => {
                    closing = Some("the browser closed the connection".into());
                    break;
                }
            },
            r = changes.changed() => {
                if r.is_err() {
                    break;
                }
                outs = px.with_reg(|reg| filter.reconcile(reg, Instant::now()));
            }
            _ = hold => outs = px.with_reg(|reg| filter.reconcile(reg, Instant::now())),
            r = stop.changed() => {
                match stop.borrow().clone() {
                    Some(reason) => closing = Some(reason),
                    None if r.is_err() => break,
                    None => {}
                }
            }
        }
    }
    let reason = closing.unwrap_or_default();
    let _ = to_agent.send(close_frame(&reason)).await;
    drop(to_agent);
    drop(to_up);
    px.with_reg(|reg| reg.conn_gone(conn));
    let _ = tokio::time::timeout(Duration::from_secs(2), agent_writer).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), up_writer).await;
}
