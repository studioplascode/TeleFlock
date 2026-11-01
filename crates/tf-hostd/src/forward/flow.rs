//! Per-stream flow control (`tf_proto::forward`): a sender keeps at most `FWD_WINDOW` bytes
//! unacknowledged per direction; a receiver acknowledges what it consumed. A sender that runs past
//! the window is cut off, and so is a receiver that acknowledges more than it got (that lie would
//! open the window of the sender behind it).

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tf_proto::{FWD_CHUNK, FWD_WINDOW};
use tokio::sync::Notify;

/// The sending side's credit for one direction of a stream.
pub(crate) struct Window {
    state: Mutex<Credit>,
    wake: Notify,
}

struct Credit {
    avail: u64,
    closed: bool,
}

impl Default for Window {
    fn default() -> Self {
        Window { state: Mutex::new(Credit { avail: FWD_WINDOW, closed: false }), wake: Notify::new() }
    }
}

impl Window {
    /// Waits for room for a whole frame and takes it: `Some(FWD_CHUNK)`, or `None` once closed.
    /// Give back what a shorter read left unused with [`Window::release`].
    pub async fn reserve(&self) -> Option<usize> {
        loop {
            {
                let mut c = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if c.closed {
                    return None;
                }
                if c.avail >= FWD_CHUNK as u64 {
                    c.avail -= FWD_CHUNK as u64;
                    return Some(FWD_CHUNK);
                }
            }
            // `notify_one` keeps a permit when nobody waits yet: no ack is missed in between.
            self.wake.notified().await;
        }
    }

    /// Returns reserved bytes that were not sent.
    pub fn release(&self, n: usize) {
        self.ack(n as u64);
    }

    /// The receiver consumed `n` bytes.
    pub fn ack(&self, n: u64) {
        let mut c = self.state.lock().unwrap_or_else(|p| p.into_inner());
        c.avail = c.avail.saturating_add(n).min(FWD_WINDOW);
        drop(c);
        self.wake.notify_one();
    }

    /// Ends every wait (the stream is over).
    pub fn close(&self) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).closed = true;
        self.wake.notify_one();
    }
}

/// The receiving side's count of bytes in flight towards it.
#[derive(Default)]
pub(crate) struct Inflight(AtomicU64);

impl Inflight {
    /// `n` bytes arrived; `false` when the sender is past its window (cut it off).
    pub fn arrived(&self, n: u64) -> bool {
        self.0.fetch_add(n, Ordering::SeqCst) + n <= FWD_WINDOW
    }

    /// `n` bytes were acknowledged; `false` (and nothing changes) when that is more than arrived.
    pub fn acked(&self, n: u64) -> bool {
        let mut cur = self.0.load(Ordering::SeqCst);
        loop {
            let Some(next) = cur.checked_sub(n) else { return false };
            match self.0.compare_exchange_weak(cur, next, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return true,
                Err(now) => cur = now,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn a_sender_waits_for_acks_and_never_exceeds_the_window() {
        let w = Arc::new(Window::default());
        let frames = (FWD_WINDOW / FWD_CHUNK as u64) as usize;
        for _ in 0..frames {
            assert_eq!(w.reserve().await, Some(FWD_CHUNK));
        }
        // The window is spent: the next frame waits.
        let w2 = w.clone();
        let next = tokio::spawn(async move { w2.reserve().await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!next.is_finished(), "no credit left");
        // Acks below a frame's size are not enough…
        w.ack(FWD_CHUNK as u64 / 2);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!next.is_finished());
        // …a whole frame's worth is.
        w.ack(FWD_CHUNK as u64 / 2);
        assert_eq!(tokio::time::timeout(Duration::from_secs(1), next).await.unwrap().unwrap(), Some(FWD_CHUNK));
        // Unused reservations come back; credit never grows past the window.
        w.release(FWD_CHUNK);
        w.ack(u64::MAX);
        for _ in 0..frames {
            assert_eq!(w.reserve().await, Some(FWD_CHUNK));
        }
        let w3 = w.clone();
        let blocked = tokio::spawn(async move { w3.reserve().await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!blocked.is_finished(), "acks beyond the window add no credit");
        w.close();
        assert_eq!(tokio::time::timeout(Duration::from_secs(1), blocked).await.unwrap().unwrap(), None);
    }

    #[test]
    fn a_receiver_cuts_off_a_sender_past_the_window_and_refuses_acks_beyond_what_arrived() {
        let f = Inflight::default();
        assert!(f.arrived(FWD_WINDOW));
        assert!(!f.arrived(1), "one byte too many");
        assert!(f.acked(FWD_WINDOW + 1));
        assert!(f.arrived(FWD_WINDOW), "acks free the window again");
        assert!(!f.acked(FWD_WINDOW + 1), "more than arrived");
        assert!(f.acked(FWD_WINDOW), "a refused ack changes nothing");
    }
}
